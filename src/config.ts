/**
 * Config do worker. Todas as credenciais vêm de env vars (Fly secrets),
 * nunca do repo. Se falta algo, o worker recusa arrancar (falha honesta).
 *
 * ATIVO: valida também que cada segredo é ASCII puro. Um char > 127
 * (ex.: bullet U+2022 = 8226) parte os headers HTTP do supabase-js com
 * "Cannot convert argument to a ByteString". Isto é o típico sintoma de
 * ter colado o HINT do vault (••••XXXX) em vez do valor real.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`ENV em falta: ${name}`); process.exit(1); }
  return v;
}

function assertAscii(name: string, value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      console.error(`❌ ${name} tem char não-ASCII no index ${i}: código ${code} ('${value[i]}')`);
      console.error(`   Primeiros 30 chars como códigos: ${value.slice(0, 30).split("").map((c) => c.charCodeAt(0)).join(",")}`);
      console.error(`   Sinal típico de teres colado o HINT do vault (••••…) em vez do valor real.`);
      process.exit(1);
    }
  }
  console.log(`✓ ${name}: ${value.length} chars ASCII (primeiro='${value[0]}' último='${value[value.length - 1]}')`);
  return value;
}

const SUPABASE_URL = assertAscii("SUPABASE_URL", required("SUPABASE_URL"));
const SUPABASE_SERVICE_ROLE_KEY = assertAscii("SUPABASE_SERVICE_ROLE_KEY", required("SUPABASE_SERVICE_ROLE_KEY"));
const ANTHROPIC_API_KEY = assertAscii("ANTHROPIC_API_KEY", required("ANTHROPIC_API_KEY"));
const GITHUB_TOKEN = assertAscii("GITHUB_TOKEN", required("GITHUB_TOKEN"));
const VERCEL_TOKEN = assertAscii("VERCEL_TOKEN", required("VERCEL_TOKEN"));

export const CONFIG = {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, VERCEL_TOKEN,
  WORKTREE_ROOT: process.env.WORKTREE_ROOT ?? "/tmp/studio",
  POLL_INTERVAL_S: Number(process.env.POLL_INTERVAL_S ?? "5"),
  DEPLOY_TIMEOUT_S: Number(process.env.DEPLOY_TIMEOUT_S ?? "360"), // 180s matava builds frios legítimos (npm install no 1º build de um projeto novo)
  MAX_TOKENS_PER_ORDER: Number(process.env.MAX_TOKENS_PER_ORDER ?? "200000"),
  WORKER_ID: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
  // Economia (2026-07-05, decisão do dono): builds correm em Sonnet 5 por
  // defeito (~5x mais barato que Fable no preço intro, quase-Opus em código);
  // quando o loop-detector muda de estratégia (caso difícil), escala p/ Fable.
  WORKER_MODEL: process.env.WORKER_MODEL ?? "claude-sonnet-5",
  WORKER_MODEL_ESCALATION: process.env.WORKER_MODEL_ESCALATION ?? "claude-fable-5",
  // Economia (2026-07-06, decisão do dono): EDIÇÕES SIMPLES (ordem sem
  // especificação de features, iter 1) correm em Haiku (~5x mais barato que
  // Sonnet). Se a edição falhar o gate, o loop-detector escala (→ Fable) — rede
  // de segurança. Kill-switch: WORKER_HAIKU_EDITS=0.
  WORKER_MODEL_SIMPLE: process.env.WORKER_MODEL_SIMPLE ?? "claude-haiku-4-5",
  HAIKU_EDITS: process.env.WORKER_HAIKU_EDITS !== "0",

  // --- TIER PROFUNDO (2026-07-12) · réplica-do-Claude-Code ---
  // Disciplina de modelos (decisão do dono): Opus para raciocínio pesado
  // (arquitetura/decomposição + verificação/diagnóstico de bugs), Sonnet para
  // implementação mecânica, Haiku para trivial (mapa do repo, classificação).
  WORKER_MODEL_ARCHITECT: process.env.WORKER_MODEL_ARCHITECT ?? "claude-opus-4-8",
  WORKER_MODEL_IMPLEMENT: process.env.WORKER_MODEL_IMPLEMENT ?? "claude-sonnet-5",
  WORKER_MODEL_VERIFY: process.env.WORKER_MODEL_VERIFY ?? "claude-opus-4-8",
  WORKER_MODEL_CHEAP: process.env.WORKER_MODEL_CHEAP ?? "claude-haiku-4-5",
  // Orçamento do tier profundo: TEMPO largo (horas) em vez de teto de iterações.
  // Budget não é travão (decisão do dono) — isto é só a rede anti-runaway.
  DEEP_BUDGET_MS: Number(process.env.STUDIO_DEEP_BUDGET_MS ?? String(4 * 60 * 60 * 1000)), // 4h
  DEEP_MAX_MILESTONES: Number(process.env.STUDIO_DEEP_MAX_MILESTONES ?? "24"),
  DEEP_MAX_FIX_ROUNDS: Number(process.env.STUDIO_DEEP_MAX_FIX_ROUNDS ?? "4"), // loop implement↔verify por milestone
};
