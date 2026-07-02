/**
 * Studio worker — main loop.
 *
 * Poll a `studio_orders WHERE estado='em_fila'` (ordem por created_at).
 * Uma ordem de cada vez (o lock por app fica atrás).
 * Graceful shutdown em SIGTERM (Fly manda quando reinicia a máquina).
 */
import { supabase, log, event, type OrderRow } from "./db.js";
import { processOrder } from "./process.js";
import { CONFIG } from "./config.js";
import { startRouter } from "./preview-router.js";
import { sweepIdle } from "./preview-manager.js";
import { interpret } from "./interpret.js";
import { killSwitchActive } from "./kill-switch.js";

let running = true;
let inflight = false;

function shutdown(sig: string) {
  console.log(`\n${sig} recebido — a terminar em cima do próximo poll…`);
  running = false;
  if (!inflight) process.exit(0);
  // Se estiver a processar uma ordem, deixa acabar (max ~3 min pelo timeout do deploy).
  setTimeout(() => { console.log("timeout de graceful — a sair"); process.exit(0); }, 210_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Brief §4.2: 2 filas na mesma poll — rascunho (interpretar) e em_fila (executar).
 * Prioridade por FIFO absoluto (created_at ASC, sem preferência de estado).
 */
async function nextOrder(): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from("studio_orders")
    .select("id, user_id, app_id, texto, modo, estado, session_id, tokens_usados")
    .in("estado", ["rascunho", "em_fila"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) { console.error("poll erro:", error.message); return null; }
  return data as OrderRow | null;
}

/**
 * Interpretação de intenção: recebe texto cru, produz frase humana, marca
 * a ordem em `aguarda_confirmacao` com o card "Avanço?".
 * Se for conversa, responde direto e marca `cancelado` (nada a executar).
 */
async function interpretRascunho(order: OrderRow): Promise<void> {
  console.log(`[${order.id.slice(0, 8)}] a interpretar rascunho…`);
  try {
    const result = await interpret(order.texto, process.env.ANTHROPIC_API_KEY!);
    if (result.kind === "conversa") {
      // Conversa direta: responde e fecha (nada para executar).
      await log(order.app_id, order.id, order.user_id, "agente", "texto", result.resposta ?? "");
      await supabase.from("studio_orders").update({
        estado: "cancelado", intencao: result.intencao || null, tokens_usados: result.tokensUsed,
      }).eq("id", order.id);
      await event(order.app_id, order.id, order.user_id, "order.conversa", { tokensUsed: result.tokensUsed });
      // Regista tokens na quota (fire-and-forget).
      supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: result.tokensUsed }).then(() => {});
      return;
    }
    // Trabalho: escreve intenção + card "confirmacao" + espera confirmação.
    await supabase.from("studio_orders").update({
      estado: "aguarda_confirmacao", intencao: result.intencao, tokens_usados: result.tokensUsed,
    }).eq("id", order.id);
    await supabase.from("studio_messages").insert({
      app_id: order.app_id, order_id: order.id, user_id: order.user_id,
      autor: "agente", tipo: "confirmacao", conteudo: { text: result.intencao },
    });
    await event(order.app_id, order.id, order.user_id, "order.intencao", { intencao: result.intencao, tokensUsed: result.tokensUsed });
    supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: result.tokensUsed }).then(() => {});
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.error(`[${order.id.slice(0, 8)}] interpretação falhou:`, motivo);
    // Em vez de rebentar, marca como aguarda_confirmacao usando o texto cru — o utilizador ainda pode avançar.
    await supabase.from("studio_orders").update({
      estado: "aguarda_confirmacao", intencao: order.texto,
    }).eq("id", order.id);
    await supabase.from("studio_messages").insert({
      app_id: order.app_id, order_id: order.id, user_id: order.user_id,
      autor: "agente", tipo: "confirmacao", conteudo: { text: order.texto },
    });
    await event(order.app_id, order.id, order.user_id, "order.intencao_fallback", { motivo });
  }
}

console.log(`Cockpit Studio Worker · ${CONFIG.WORKER_ID}`);
console.log(`Supabase: ${CONFIG.SUPABASE_URL}`);
console.log(`Poll a cada ${CONFIG.POLL_INTERVAL_S}s · orçamento max ${CONFIG.MAX_TOKENS_PER_ORDER} tokens/ordem`);

// Fatia 3b/3c: arranca o router HTTP em paralelo ao poll loop, no mesmo processo Node.
// A porta 8080 fica exposta pelo Fly [http_service]. Idle sweeper mata dev servers
// sem tráfego há mais de 20 min.
startRouter(8080);
setInterval(sweepIdle, 60_000);

while (running) {
  try {
    const order = await nextOrder();
    if (!order) {
      await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
      continue;
    }
    // Brief §4.11: kill-switch (global ou por app). Não corta ordens em curso —
    // apenas recusa novas. Registamos como cancelado com motivo para o utilizador
    // saber que o dono pausou (linguagem humana).
    const kill = await killSwitchActive(order.app_id);
    if (kill.active) {
      console.log(`[${order.id.slice(0, 8)}] kill-switch: ${kill.motivo}`);
      await supabase.from("studio_orders").update({
        estado: "cancelado", erro: "O dono pausou temporariamente novas ordens. Tenta daqui a pouco.",
      }).eq("id", order.id);
      await log(order.app_id, order.id, order.user_id, "sistema", "erro_humano", "Novas ordens estão pausadas pelo dono. Vou voltar assim que reativarem.");
      await event(order.app_id, order.id, order.user_id, "worker.kill_switch", { motivo: kill.motivo });
      continue;
    }
    inflight = true;
    // 2 pipelines: interpretação (rápido) vs execução (longo).
    if (order.estado === "rascunho") {
      await interpretRascunho(order);
    } else {
      await processOrder(order);
    }
    inflight = false;
  } catch (e) {
    inflight = false;
    console.error("loop erro:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
  }
}
console.log("worker terminado.");
