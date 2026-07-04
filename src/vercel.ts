/**
 * Vercel API — só o que o worker precisa: encontrar o deploy da branch e
 * fazer poll até READY. NUNCA fabrica URL — se timeout, propaga o erro.
 */
import { CONFIG } from "./config.js";

const UA = `cockpit-worker/${CONFIG.WORKER_ID}`;

async function api(path: string): Promise<Response> {
  return fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${CONFIG.VERCEL_TOKEN}`, "User-Agent": UA },
  });
}

type Deployment = { uid: string; readyState: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED"; url: string; meta?: Record<string, string> };

/**
 * Encontra o deploy de preview associado à branch (por meta.githubCommitRef).
 * Se `sha` for dado, exige meta.githubCommitSha === sha — sem isto, um deploy
 * READY de uma tentativa ANTERIOR na mesma branch era devolvido e os gates
 * validavam um build que não é o commit (visto na ordem d22c6f5a, 2026-07-04).
 * Faz poll até READY ou timeout.
 */
export async function waitForPreviewDeploy(projectId: string, branch: string, sha?: string): Promise<{ url: string; deployId: string }> {
  const deadline = Date.now() + CONFIG.DEPLOY_TIMEOUT_S * 1000;
  let lastState: string | null = null;

  while (Date.now() < deadline) {
    const r = await api(`/v6/deployments?projectId=${projectId}&target=preview&limit=20`);
    if (!r.ok) throw new Error(`Vercel ${r.status}: ${await r.text()}`);
    const json = await r.json() as { deployments: Deployment[] };

    // Encontra o mais recente da nossa branch — e do nosso commit, se conhecido.
    const match = json.deployments.find((d) =>
      d.meta?.githubCommitRef === branch && (!sha || d.meta?.githubCommitSha === sha));
    if (match) {
      if (match.readyState === "READY") return { url: `https://${match.url}`, deployId: match.uid };
      if (match.readyState === "ERROR" || match.readyState === "CANCELED") throw new Error(`deploy terminou em ${match.readyState}`);
      lastState = match.readyState;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timeout ${CONFIG.DEPLOY_TIMEOUT_S}s à espera do deploy READY (último estado: ${lastState ?? "não encontrado"})`);
}
