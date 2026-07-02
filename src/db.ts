/**
 * Supabase client com service-role — bypass RLS (worker corre como sistema).
 * O user_id de cada ordem/mensagem é preservado (worker apenas escreve em nome
 * do dono da app, nunca cria linhas soltas).
 */
import { createClient } from "@supabase/supabase-js";
import { CONFIG } from "./config.js";

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type OrderRow = {
  id: string;
  user_id: string;
  app_id: string;
  texto: string;
  modo: "build" | "chat";
  estado: string;
  session_id: string | null;
  tokens_usados: number;
};

export type AppRow = {
  id: string;
  user_id: string;
  slug: string;
  nome: string;
  github_repo: string | null;
  vercel_project_id: string | null;
  template: string;
};

export type Plano = { passos: { id: string; titulo: string; estado: "por_fazer" | "em_execucao" | "feito" | "falhou" }[] };

export async function log(appId: string, orderId: string, userId: string, autor: "sistema" | "agente", tipo: "texto" | "erro" | "estado" | "atividade" | "pensamento", text: string) {
  await supabase.from("studio_messages").insert({ app_id: appId, order_id: orderId, user_id: userId, autor, tipo, conteudo: { text } });
}

/**
 * Studio Fatia 4b: escreve linhas no terminal integrado.
 *
 * seq é monotonic dentro da ordem (a UI usa para pedir só o delta desde a
 * última). Batch para reduzir carga: podes juntar N linhas e chamar 1x.
 * Fire-and-forget — se falhar, apenas perdemos o terminal, não a ordem.
 */
type RunLogStream = "stdout" | "stderr" | "tool" | "edit" | "deploy" | "info";
const _seqByOrder = new Map<string, number>();
export async function runlog(orderId: string, stream: RunLogStream, linha: string): Promise<void> {
  const seq = (_seqByOrder.get(orderId) ?? 0) + 1;
  _seqByOrder.set(orderId, seq);
  await supabase.from("studio_runlog").insert({ order_id: orderId, seq, stream, linha }).then((r) => {
    if (r.error) console.warn(`[${orderId.slice(0, 8)}] runlog falhou: ${r.error.message}`);
  });
}
export function resetRunlogSeq(orderId: string) { _seqByOrder.delete(orderId); }

export async function event(appId: string, orderId: string | null, userId: string, tipo: string, payload: Record<string, unknown> = {}) {
  await supabase.from("studio_events").insert({ app_id: appId, order_id: orderId, user_id: userId, tipo, payload });
}

/**
 * Adquire lock. Retorna true/false. Bypass RLS via service-role: usamos
 * INSERT direto (o RPC studio_try_acquire_lock precisa de auth.uid()).
 */
export async function tryLock(appId: string, orderId: string, userId: string): Promise<boolean> {
  const { error } = await supabase.from("studio_locks").insert({ app_id: appId, order_id: orderId, user_id: userId });
  if (error) {
    if (error.code === "23505") return false; // já ocupado
    throw error;
  }
  return true;
}

export async function unlock(appId: string) {
  await supabase.from("studio_locks").delete().eq("app_id", appId);
}
