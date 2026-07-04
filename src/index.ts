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
 * Interpretação de intenção: recebe texto cru, produz frase humana, marca
 * a ordem em `aguarda_confirmacao` com o card "Avanço?".
 * Se for conversa, responde direto e marca `cancelado` (nada a executar).
 */
async function interpretRascunho(order: OrderRow): Promise<void> {
  console.log(`[${order.id.slice(0, 8)}] a interpretar rascunho…`);
  try {
    // Fatia B · aviso IMEDIATO antes de chamar o LLM (mata os primeiros 5s de silêncio)
    await log(order.app_id, order.id, order.user_id, "agente", "pensamento", "A perceber o que queres…");
    const result = await interpret(order.texto, process.env.ANTHROPIC_API_KEY!);
    console.log(`[${order.id.slice(0, 8)}] interpret result kind=${result.kind} tokens=${result.tokensUsed}`);
    if (result.kind === "conversa") {
      await log(order.app_id, order.id, order.user_id, "agente", "texto", result.resposta ?? "");
      await supabase.from("studio_orders").update({
        estado: "cancelado", intencao: result.intencao || null, tokens_usados: result.tokensUsed,
      }).eq("id", order.id);
      await event(order.app_id, order.id, order.user_id, "order.conversa", { tokensUsed: result.tokensUsed });
      supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: result.tokensUsed }).then(() => {});
      return;
    }

    // Brief §4.8 roteamento app-nova: o pedido é obviamente uma app diferente.
    // Não recusa — regista intenção com propostinha de nome. A UI mostra o card
    // "Vou criar uma app nova (X). Avanço?" e o cockpit encaminha para o
    // Scaffolder no confirm(). O 0-coder nunca vê "reformula o pedido".
    if (result.kind === "app_nova") {
      const intencaoComRota = result.intencao + (result.nomeAppSugerido ? `\n\nNome sugerido: ${result.nomeAppSugerido}` : "");
      await supabase.from("studio_orders").update({
        estado: "aguarda_confirmacao", intencao: intencaoComRota, tokens_usados: result.tokensUsed,
      }).eq("id", order.id);
      await supabase.from("studio_messages").insert({
        app_id: order.app_id, order_id: order.id, user_id: order.user_id,
        autor: "agente", tipo: "confirmacao", conteudo: { text: intencaoComRota, kind: "app_nova", nome: result.nomeAppSugerido },
      });
      await event(order.app_id, order.id, order.user_id, "order.app_nova", { intencao: result.intencao, nome: result.nomeAppSugerido });
      supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: result.tokensUsed }).then(() => {});
      return;
    }

    // Trabalho normal: escreve intenção + card "confirmacao".
    // Se há especificação (pedido vago → spec benchmark), guarda no campo
    // intencao junto do resumo — o process.ts passa isto ao agente como spec
    // aprovada, e o card mostra a lista para o 0-coder ver o que aprova.
    const intencaoCompleta = result.especificacao && result.especificacao.length > 0
      ? `${result.intencao}\n\nO que vou incluir:\n${result.especificacao.map((f) => `• ${f}`).join("\n")}`
      : result.intencao;
    const upd = await supabase.from("studio_orders").update({
      estado: "aguarda_confirmacao", intencao: intencaoCompleta, tokens_usados: result.tokensUsed,
    }).eq("id", order.id);
    if (upd.error) throw upd.error;
    await supabase.from("studio_messages").insert({
      app_id: order.app_id, order_id: order.id, user_id: order.user_id,
      autor: "agente", tipo: "confirmacao",
      conteudo: { text: result.intencao, especificacao: result.especificacao ?? null },
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

// DISCO (2026-07-04): limpeza no arranque + periódica. A causa do
// "unable to write new index file" era acumulação: worktrees de ordens em
// /tmp/studio nunca eram apagados, e os clones dos dev servers em /data/apps
// enchiam o volume. No boot nada está in-flight → apaga /tmp/studio inteiro.
// /data/apps: mantém só os 4 dev servers mais recentes (LRU). SEGURO em
// qualquer momento — os dev servers re-clonam on-demand e não são worktrees
// de ordens ativas.
async function lruDevServers() {
  const { rm, readdir, stat } = await import("node:fs/promises");
  try {
    const root = "/data/apps";
    const dirs = await readdir(root).catch(() => []);
    const comMtime = await Promise.all(dirs.map(async (d) => ({ d, m: (await stat(`${root}/${d}`).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    comMtime.sort((a, b) => b.m - a.m);
    for (const { d } of comMtime.slice(4)) {
      await rm(`${root}/${d}`, { recursive: true, force: true }).catch(() => {});
      console.log(`disco: /data/apps/${d} removido (LRU)`);
    }
  } catch { /* ok */ }
}
// ARRANQUE: aqui NADA está a correr → é seguro limpar /tmp/studio inteiro.
async function limparDiscoArranque() {
  const { rm } = await import("node:fs/promises");
  try { await rm(CONFIG.WORKTREE_ROOT, { recursive: true, force: true }); console.log("disco: /tmp/studio limpo (arranque)"); } catch { /* ok */ }
  await lruDevServers();
}
await limparDiscoArranque();

// LOCKS ÓRFÃOS (2026-07-04): num restart, os Sets in-flight in-memory zeram
// mas os studio_locks na BD persistem → orders dessa app nunca avançam e o
// poll entra em hot-loop a relançá-las. No boot, NADA está in-flight, logo
// todos os locks são órfãos → limpa. (Causou 1h53 de worker preso.)
async function limparLocksOrfaos() {
  const { supabase } = await import("./db.js");
  const { error, count } = await supabase.from("studio_locks").delete({ count: "exact" }).not("app_id", "is", null);
  console.log(error ? `locks: falha ao limpar (${error.message})` : `locks: ${count ?? 0} órfãos limpos no arranque`);
}
await limparLocksOrfaos();

// Fatia 3b/3c: arranca o router HTTP em paralelo ao poll loop, no mesmo processo Node.
// A porta 8080 fica exposta pelo Fly [http_service]. Idle sweeper mata dev servers
// sem tráfego há mais de 20 min.
startRouter(8080);
setInterval(sweepIdle, 60_000);
// disco: PERIÓDICO só o LRU dos dev servers — NUNCA /tmp/studio (lá vivem os
// worktrees das ordens ATIVAS; apagá-los a meio matava o commit final com
// `spawn git ENOENT`). Os worktrees são limpos pelo finally de cada ordem.
setInterval(() => { lruDevServers().catch(() => {}); }, 10 * 60_000);

// CONCORRÊNCIA: uma ordem grande não pode monopolizar o worker inteiro.
// Processamos até MAX_CONCURRENT ordens em paralelo, de APPS DIFERENTES
// (studio_locks já garante 1 ordem/app; o in-flight set evita duplo arranque
// da mesma ordem entre o poll e o lock).
// 2026-07-03: 3→2 depois de OOM real (npm de 2 agentes + dev server + chromium
// nao cabem em 1GB; 2 concurrent + 2GB + swap aguenta).
const MAX_CONCURRENT = 2;
const inflightOrders = new Set<string>();
const inflightApps = new Set<string>();

async function nextEligible(): Promise<OrderRow | null> {
  const { data: bloqueadas } = await supabase.from("studio_campaigns").select("id").eq("estado", "bloqueada");
  const idsBloqueadas = ((bloqueadas ?? []) as { id: string }[]).map((c) => c.id);
  let q = supabase
    .from("studio_orders")
    .select("id, user_id, app_id, texto, modo, estado, session_id, tokens_usados")
    .in("estado", ["rascunho", "em_fila"])
    .order("created_at", { ascending: true })
    .limit(10);
  if (idsBloqueadas.length > 0) {
    q = q.or(`campaign_id.is.null,campaign_id.not.in.(${idsBloqueadas.join(",")})`);
  }
  const { data, error } = await q;
  if (error) { console.error("poll erro:", error.message); return null; }
  for (const o of (data ?? []) as OrderRow[]) {
    if (inflightOrders.has(o.id)) continue;
    if (inflightApps.has(o.app_id)) continue; // outra ordem desta app já em curso aqui
    return o;
  }
  return null;
}

function launchOrder(order: OrderRow): void {
  inflightOrders.add(order.id);
  inflightApps.add(order.app_id);
  inflight = true;
  const pipeline = order.estado === "rascunho" ? interpretRascunho(order) : processOrder(order);
  pipeline
    .catch((e) => console.error(`[${order.id.slice(0, 8)}] pipeline erro:`, e instanceof Error ? e.message : e))
    .finally(() => {
      inflightOrders.delete(order.id);
      inflightApps.delete(order.app_id);
      inflight = inflightOrders.size > 0;
    });
}

while (running) {
  try {
    if (inflightOrders.size >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
      continue;
    }
    const order = await nextEligible();
    if (!order) {
      await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
      continue;
    }
    // Brief §4.11: kill-switch (global ou por app).
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
    console.log(`[${order.id.slice(0, 8)}] launch (${inflightOrders.size + 1}/${MAX_CONCURRENT} em curso)`);
    launchOrder(order);
    // Pequena pausa entre launches para o estado da BD assentar (em_execucao)
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    console.error("loop erro:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
  }
}
console.log("worker terminado.");
