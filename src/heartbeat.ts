/**
 * Fatia B · heartbeat do worker.
 *
 * Cria uma mensagem `pensamento` no chat a cada N segundos se não houver
 * outra actividade recente. Evita silêncio > 10s durante o agente correr.
 *
 * Uso:
 *   const stop = startHeartbeat({ appId, orderId, userId });
 *   try { await longRunningWork(); } finally { stop(); }
 */
import { supabase } from "./db.js";
import { HEARTBEAT_PHRASES } from "./humanize.js";

// 2026-07-06: 8→14s + limiar 6→11s. O heartbeat só deve encher o SILÊNCIO real
// (o LLM a pensar entre rajadas de tools); a 8s enchia demasiado e a narração
// genérica parecia "presa a pensar" por cima da atividade real. Menos é mais.
const INTERVAL_MS = 14_000;
const SILENCE_THRESHOLD_MS = 11_000;

export function startHeartbeat(ctx: { appId: string; orderId: string; userId: string }): () => void {
  let idx = 0;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    // Verifica se houve mensagem recente do agente (evita spam)
    const cutoff = new Date(Date.now() - SILENCE_THRESHOLD_MS).toISOString();
    const { data: recente } = await supabase
      .from("studio_messages")
      .select("id")
      .eq("order_id", ctx.orderId)
      .in("autor", ["agente", "sistema"])
      .gte("created_at", cutoff)
      .limit(1);
    if (recente && recente.length > 0) return; // houve actividade — não repita

    const phrase = HEARTBEAT_PHRASES[idx % HEARTBEAT_PHRASES.length];
    idx++;
    await supabase.from("studio_messages").insert({
      app_id: ctx.appId, order_id: ctx.orderId, user_id: ctx.userId,
      autor: "agente", tipo: "pensamento", conteudo: { text: phrase },
    });
  }, INTERVAL_MS);

  return () => { stopped = true; clearInterval(timer); };
}
