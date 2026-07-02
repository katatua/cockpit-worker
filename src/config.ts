/**
 * Config do worker. Todas as credenciais vêm de env vars (Fly secrets),
 * nunca do repo. Se falta algo, o worker recusa arrancar (falha honesta).
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`ENV em falta: ${name}`); process.exit(1); }
  return v;
}

export const CONFIG = {
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  GITHUB_TOKEN: required("GITHUB_TOKEN"),
  VERCEL_TOKEN: required("VERCEL_TOKEN"),
  // Diretorio de worktrees (limpo entre ordens).
  WORKTREE_ROOT: process.env.WORKTREE_ROOT ?? "/tmp/studio",
  // Segundos entre polls quando não há trabalho.
  POLL_INTERVAL_S: Number(process.env.POLL_INTERVAL_S ?? "5"),
  // Segundos max à espera do deploy Vercel READY.
  DEPLOY_TIMEOUT_S: Number(process.env.DEPLOY_TIMEOUT_S ?? "180"),
  // Teto de tokens por ordem (guardrail A8 do brief).
  MAX_TOKENS_PER_ORDER: Number(process.env.MAX_TOKENS_PER_ORDER ?? "200000"),
  // Identidade do worker (para logs).
  WORKER_ID: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
};
