/**
 * Wrapper `git` — spawn simples. Cada função devolve stdout ou lança.
 * Autenticação é feita pelo URL do remote (`x-access-token:${TOKEN}@github.com/...`).
 */
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

/**
 * SEGURANÇA (2026-07-04): o token NUNCA pode aparecer em erros/logs. Um clone
 * falhado ecoava `git clone https://x-access-token:TOKEN@github.com/...` no
 * stderr, que subia até ao chat do 0-coder. Esta função apaga qualquer
 * segredo conhecido (o GITHUB_TOKEN, o padrão ghp_/gho_, e o user:token@ do
 * URL) de qualquer string antes de a deixar sair daqui.
 */
export function redactSecrets(s: string): string {
  let out = s;
  if (CONFIG.GITHUB_TOKEN) out = out.split(CONFIG.GITHUB_TOKEN).join("‹token›");
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "‹token›");
  out = out.replace(/x-access-token:[^@\s]+@/g, "x-access-token:‹token›@");
  out = out.replace(/https:\/\/[^:@\s/]+:[^@\s/]+@/g, "https://‹redacted›@");
  return out;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
    let out = ""; let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("close", (code) => code === 0
      ? resolve(out)
      // redação em camadas: o cmd+args (que inclui o URL autenticado) e o
      // stderr passam ambos pelo filtro antes de virarem Error.
      : reject(new Error(redactSecrets(`${cmd} ${args.join(" ")}: exit ${code}\n${err}`))));
    child.on("error", (e) => reject(new Error(redactSecrets(e.message))));
  });
}

export function authedRepoUrl(fullName: string): string {
  return `https://x-access-token:${CONFIG.GITHUB_TOKEN}@github.com/${fullName}.git`;
}

export async function cleanWorktree(orderId: string): Promise<string> {
  // Guarda-fogo: sem orderId válido, path.join devolvia a RAIZ e o rm
  // apagava /tmp/studio inteiro — worktrees de ordens ativas incluídos.
  if (!orderId || orderId.includes("..") || orderId.includes("/")) {
    throw new Error(`cleanWorktree: orderId inválido ("${orderId}")`);
  }
  const dir = path.join(CONFIG.WORKTREE_ROOT, orderId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function shallowClone(fullName: string, dir: string, baseBranch?: string): Promise<void> {
  const url = authedRepoUrl(fullName);
  // CONTINUIDADE (2026-07-12): se houver uma branch base (o preview mais recente
  // da app), clona ESSA — assim a ordem constrói SOBRE a última versão que o
  // utilizador viu, não a partir de main (que só tem o scaffold até publicar).
  // Se a branch base já não existir no remoto (apagada), cai para o default.
  if (baseBranch) {
    try {
      await run("git", ["clone", "--depth", "1", "--branch", baseBranch, url, dir]);
      return;
    } catch {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
  }
  await run("git", ["clone", "--depth", "1", url, dir]);
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  await run("git", ["checkout", "-b", branch], { cwd: dir });
}

export async function hasChanges(dir: string): Promise<boolean> {
  const out = await run("git", ["status", "--porcelain"], { cwd: dir });
  return out.trim().length > 0;
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", message], { cwd: dir });
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
  return sha;
}

export async function push(dir: string, branch: string): Promise<void> {
  // --force: branches studio/* são descartáveis e 1:1 com a ordem. Depois de
  // um retry (re-clone do main + re-trabalho), o branch remoto antigo teria
  // commits divergentes e um push normal falharia com non-fast-forward.
  // NUNCA usado em main — o publish gate faz merge por outra via.
  await run("git", ["push", "-u", "--force", "origin", branch], { cwd: dir });
}

export async function diffStat(dir: string): Promise<string> {
  return (await run("git", ["diff", "--stat", "HEAD~1..HEAD"], { cwd: dir })).trim();
}

/** Exposto para o revert directo em process.ts. */
export const runCmd = run;
