/**
 * Brief §4.11 · kill-switch do dono.
 *
 * Antes de cada poll o worker verifica se há uma entrada activa em
 * `studio_kill_switch` (global — app_id NULL — ou específica de uma app).
 *
 * - Global ativo: worker recusa qualquer nova ordem
 * - Por app: só ordens dessa app são recusadas
 *
 * Não interrompe uma ordem em curso — respeita o "custo é telemetria, não
 * travão" (§1). Impede novas.
 */
import { supabase } from "./db.js";

let cached: { global: boolean; perApp: Set<string>; at: number } = { global: false, perApp: new Set(), at: 0 };
const CACHE_MS = 5000;

export async function killSwitchActive(appId?: string): Promise<{ active: boolean; motivo?: string }> {
  const now = Date.now();
  if (now - cached.at > CACHE_MS) {
    const { data } = await supabase
      .from("studio_kill_switch")
      .select("app_id, motivo")
      .is("desativado_at", null);
    const rows = (data ?? []) as { app_id: string | null; motivo: string | null }[];
    cached = {
      global: rows.some((r) => r.app_id === null),
      perApp: new Set(rows.filter((r) => r.app_id !== null).map((r) => r.app_id as string)),
      at: now,
    };
  }
  if (cached.global) return { active: true, motivo: "kill-switch global do dono" };
  if (appId && cached.perApp.has(appId)) return { active: true, motivo: "kill-switch por app do dono" };
  return { active: false };
}
