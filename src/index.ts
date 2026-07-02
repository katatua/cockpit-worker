/**
 * Studio worker — main loop.
 *
 * Poll a `studio_orders WHERE estado='em_fila'` (ordem por created_at).
 * Uma ordem de cada vez (o lock por app fica atrás).
 * Graceful shutdown em SIGTERM (Fly manda quando reinicia a máquina).
 */
import { supabase, type OrderRow } from "./db.js";
import { processOrder } from "./process.js";
import { CONFIG } from "./config.js";

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

async function nextOrder(): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from("studio_orders")
    .select("id, user_id, app_id, texto, modo, estado, session_id, tokens_usados")
    .eq("estado", "em_fila")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) { console.error("poll erro:", error.message); return null; }
  return data as OrderRow | null;
}

console.log(`Cockpit Studio Worker · ${CONFIG.WORKER_ID}`);
console.log(`Supabase: ${CONFIG.SUPABASE_URL}`);
console.log(`Poll a cada ${CONFIG.POLL_INTERVAL_S}s · orçamento max ${CONFIG.MAX_TOKENS_PER_ORDER} tokens/ordem`);

while (running) {
  try {
    const order = await nextOrder();
    if (!order) {
      await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
      continue;
    }
    inflight = true;
    await processOrder(order);
    inflight = false;
  } catch (e) {
    inflight = false;
    console.error("loop erro:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_S * 1000));
  }
}
console.log("worker terminado.");
