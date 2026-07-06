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

// Máximo de heartbeats CONSECUTIVOS (sem atividade real pelo meio) antes de o
// worker se calar. Um silêncio muito longo é anómalo (o reaper/watchdog trata
// disso); encher o chat de "ainda a trabalhar…" indefinidamente é ruído.
const MAX_CONSECUTIVOS = 3;

export function startHeartbeat(ctx: { appId: string; orderId: string; userId: string }): () => void {
  let consecutivos = 0; // heartbeats seguidos sem atividade real pelo meio
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    // Houve mensagem recente do agente? Se sim, o trabalho está a falar por si —
    // não sobrepomos heartbeat E reiniciamos a escalada (a próxima pausa começa
    // outra vez na frase serena, não na de "isto é demorado").
    const cutoff = new Date(Date.now() - SILENCE_THRESHOLD_MS).toISOString();
    const { data: recente } = await supabase
      .from("studio_messages")
      .select("id")
      .eq("order_id", ctx.orderId)
      .in("autor", ["agente", "sistema"])
      .gte("created_at", cutoff)
      .limit(1);
    if (recente && recente.length > 0) { consecutivos = 0; return; }

    if (consecutivos >= MAX_CONSECUTIVOS) return; // silêncio longo → cala-se
    // Escala: 1ª pausa = frase serena; a partir da 2ª = "isto é demorado".
    const phrase = HEARTBEAT_PHRASES[Math.min(consecutivos, HEARTBEAT_PHRASES.length - 1)];
    consecutivos++;
    await supabase.from("studio_messages").insert({
      app_id: ctx.appId, order_id: ctx.orderId, user_id: ctx.userId,
      autor: "agente", tipo: "pensamento", conteudo: { text: phrase },
    });
  }, INTERVAL_MS);

  return () => { stopped = true; clearInterval(timer); };
}
