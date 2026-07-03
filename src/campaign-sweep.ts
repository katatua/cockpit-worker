/**
 * Brief §4.9 · varredura de spec após campanha.
 *
 * Depois de todos os WPs `nao_feito` da campanha marcarem `feito`, corre-se a
 * varredura: um LLM lê SPEC.md do repo + a árvore de ficheiros e determina o
 * estado real de cada item da spec:
 *   - `feito`: implementado e visível
 *   - `iniciado`: parcialmente feito (esboço ou stubs)
 *   - `nao_feito`: mencionado na spec mas ausente no código
 *   - `indeciso`: LLM não consegue decidir (falta contexto ou linguagem ambígua)
 *
 * Se houver `iniciado`/`nao_feito`/`indeciso`, gera nova campanha (ronda+1)
 * com WPs SÓ para esses gaps, com razão explícita. Ciclo repete até tudo
 * feito ou até o dono pausar (kill-switch).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "./db.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type SweepItem = {
  titulo: string;
  estado: "feito" | "iniciado" | "nao_feito" | "indeciso";
  razao?: string;
};

async function listFiles(dir: string, base: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6 || out.length > 200) return;
  const IGNORE = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "coverage"]);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, base, out, depth + 1);
    else if (/\.(tsx?|jsx?|md|css|json)$/.test(e.name)) out.push(p.replace(base + "/", ""));
  }
}

/** Faz o sweep: LLM lê SPEC.md + tree e devolve estado de cada item. */
export async function sweepSpec(worktree: string, apiKey: string): Promise<{ items: SweepItem[]; tokensUsed: number }> {
  const specPath = join(worktree, "SPEC.md");
  const spec = await readFile(specPath, "utf8").catch(() => "");
  if (!spec.trim()) return { items: [], tokensUsed: 0 };

  const files: string[] = [];
  await listFiles(worktree, worktree, files);
  const tree = files.slice(0, 150).join("\n");

  const systemPrompt = `És o avaliador de progresso de uma spec (SPEC.md) contra o código real de uma app.
Recebes a SPEC.md e a lista de ficheiros do repo. Analisa item a item da spec e classifica cada um:
- "feito": há código que implementa este item de forma visível
- "iniciado": há esboço/stub mas não está funcional
- "nao_feito": mencionado na spec, ausente no repo
- "indeciso": não consegues decidir com o que tens

Devolve JSON: { "items": [ { "titulo": "...", "estado": "feito|iniciado|nao_feito|indeciso", "razao": "..." (opcional) } ] }
- Cada item = uma frase/ponto da spec que possa ser verificado.
- Máximo 15 items.
- Razão obrigatória para tudo != "feito".`;

  const userMessage = `SPEC.md:\n${spec.slice(0, 4000)}\n\nÁrvore de ficheiros:\n${tree.slice(0, 3000)}`;

  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-fable-5",
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!r.ok) throw new Error(`sweep: Anthropic ${r.status}`);
  const j = await r.json() as { content: { type: string; text: string }[]; usage: { input_tokens: number; output_tokens: number } };
  const textBlock = j.content.find((c) => c.type === "text");
  if (!textBlock) throw new Error("sweep: sem text block");
  let parsed: { items: SweepItem[] };
  try { parsed = JSON.parse(textBlock.text); }
  catch { throw new Error("sweep: JSON inválido"); }

  return {
    items: parsed.items ?? [],
    tokensUsed: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0),
  };
}

/**
 * Depois do sweep, cria nova campanha (ronda+1) com WPs para os gaps.
 * Devolve o id da nova campanha, ou null se não há gaps (tudo `feito`).
 */
export async function scheduleNextRound(oldCampaignId: string, appId: string, userId: string, worktree: string, apiKey: string): Promise<{ campaign_id: string | null; items: SweepItem[]; tokensUsed: number }> {
  const { items, tokensUsed } = await sweepSpec(worktree, apiKey);
  const gaps = items.filter((i) => i.estado !== "feito");
  if (gaps.length === 0) return { campaign_id: null, items, tokensUsed };

  // Atualiza old workpackages com estados reais (feito|iniciado|nao_feito|indeciso).
  // Adicionamos registos novos para os gaps, referenciando spec_ref.
  const { data: oldCampaign } = await supabase.from("studio_campaigns")
    .select("ronda, app_id, spec_ref")
    .eq("id", oldCampaignId)
    .single();
  const ronda = ((oldCampaign as { ronda?: number } | null)?.ronda ?? 1) + 1;

  const { data: novaCampaign } = await supabase.from("studio_campaigns").insert({
    app_id: appId, spec_ref: (oldCampaign as { spec_ref?: string } | null)?.spec_ref ?? "SPEC.md",
    estado: "a_executar", ronda,
  }).select("id").single();

  const wps = gaps.map((g, i) => ({
    campaign_id: novaCampaign?.id,
    ordem: i + 1,
    titulo: g.titulo,
    spec_ref: `SPEC.md#round${ronda}`,
    estado: "nao_feito",
    razao: g.razao ?? `resta: ${g.estado}`,
  }));
  await supabase.from("studio_workpackages").insert(wps);

  // Cria a primeira ordem da nova ronda
  if (wps[0]) {
    await supabase.from("studio_orders").insert({
      app_id: appId, campaign_id: novaCampaign?.id, tipo: "campanha", user_id: userId,
      texto: `[Campanha ronda ${ronda} · WP 1/${wps.length}] ${wps[0].titulo}: ${wps[0].razao}`,
      modo: "build", estado: "em_fila",
    });
  }

  return { campaign_id: novaCampaign?.id ?? null, items, tokensUsed };
}
