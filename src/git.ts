/**
 * Wrapper `git` — spawn simples. Cada função devolve stdout ou lança.
 * Autenticação é feita pelo URL do remote (`x-access-token:${TOKEN}@github.com/...`).
 */
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
    let out = ""; let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")}: exit ${code}\n${err}`)));
    child.on("error", reject);
  });
}

export function authedRepoUrl(fullName: string): string {
  return `https://x-access-token:${CONFIG.GITHUB_TOKEN}@github.com/${fullName}.git`;
}

export async function cleanWorktree(orderId: string): Promise<string> {
  const dir = path.join(CONFIG.WORKTREE_ROOT, orderId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function shallowClone(fullName: string, dir: string): Promise<void> {
  await run("git", ["clone", "--depth", "1", authedRepoUrl(fullName), dir]);
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
  await run("git", ["push", "-u", "origin", branch], { cwd: dir });
}

export async function diffStat(dir: string): Promise<string> {
  return (await run("git", ["diff", "--stat", "HEAD~1..HEAD"], { cwd: dir })).trim();
}

/** Exposto para o revert directo em process.ts. */
export const runCmd = run;
