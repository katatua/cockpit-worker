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
  DEPLOY_TIMEOUT_S: Number(process.env.DEPLOY_TIMEOUT_S ?? "180"),
  MAX_TOKENS_PER_ORDER: Number(process.env.MAX_TOKENS_PER_ORDER ?? "200000"),
  WORKER_ID: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
};
