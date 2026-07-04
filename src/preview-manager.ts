/**
 * Studio Fatia 3c · gestor de dev servers por app.
 *
 * Cada app tem UM dev server persistente na sua porta (3001+). Início lazy:
 * spawn na primeira request `/preview/:slug/*`. Idle-timeout desliga após
 * 20 min sem tráfego (poupa CPU + memória).
 *
 * Persistência de disco:
 *   /data/apps/<slug>/           ← worktree (git clone da main)
 *     .next/, node_modules/       ← preservados entre reboots (Fly volume)
 *
 * A branch usada é sempre `main` (após o publish gate). Para preview de uma
 * ordem em specifico, o iframe usa o Vercel preview URL — este dev server
 * mostra o estado publicado, que é o padrão do Lovable ("o que está deployado
 * agora"). Hot-reload real para ordens em construção fica para Fatia 3d.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { supabase } from "./db.js";
import { authedRepoUrl, cleanWorktree } from "./git.js";
import { spawnPromise } from "./spawn-helpers.js";

const APPS_ROOT = "/data/apps";
const PORT_START = 3001;
const PORT_END = 3099;
const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

type PreviewProc = {
  slug: string;
  appId: string;
  port: number;
  proc: ChildProcess;
  startedAt: number;
  lastActive: number;
  ready: boolean;
  readyPromise: Promise<void>;
  branch: string;    // C1.2: a branch que este dev server está a servir
  lastPull: number;  // C1: throttle do refresh (fetch+reset) por pedido
};

const running = new Map<string, PreviewProc>();
const usedPorts = new Set<number>();
// GUARDA anti-corrida: `running` só é populado DEPOIS do clone+npm ci (que
// demora minutos). Sem isto, cada poll do iframe durante essa janela disparava
// outro spawnPreview — vários `git reset --hard` + `next dev` no MESMO dir a
// matarem-se uns aos outros (visto no e2e: portas 3001/3002/3003 em corrida,
// READY seguido de exit). Chamadas concorrentes partilham a mesma promise.
const inflight = new Map<string, Promise<{ port: number; ready: boolean }>>();

function nextPort(): number {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!usedPorts.has(p)) return p;
  }
  throw new Error("preview: sem portas disponíveis");
}

/**
 * Devolve a porta interna do dev server para este slug — arranca-o se ainda
 * não está a correr, espera que fique READY. Marca lastActive.
 *
 * C1.2 (delta 2026-07-04): o dev server serve a BRANCH pedida (a da ordem
 * ativa), nunca cegamente main. Se está a correr noutra branch, reinicia na
 * certa. Pedidos com a mesma branch fazem refresh throttled (fetch+reset a
 * cada ≥20s) — o próximo hot-reload do Next apanha os commits do agente.
 */
export async function ensurePreview(slug: string, branch = "main"): Promise<{ port: number; ready: boolean }> {
  const existing = running.get(slug);
  if (existing) {
    existing.lastActive = Date.now();
    if (existing.branch !== branch) {
      // C1.2: ordem ativa mudou de branch → reinicia na branch certa.
      console.log(`[preview:${slug}] branch ${existing.branch} → ${branch} · reiniciar`);
      stop(slug);
    } else {
      if (!existing.ready) {
        try { await existing.readyPromise; } catch { /* proc falhou; respawn abaixo */ }
      }
      if (existing.ready) {
        refreshBranch(existing).catch(() => {});
        return { port: existing.port, ready: true };
      }
      stop(slug);
    }
  }
  const emCurso = inflight.get(slug);
  if (emCurso) return emCurso;
  const p = spawnPreview(slug, branch).finally(() => inflight.delete(slug));
  inflight.set(slug, p);
  return p;
}

/** C1: refresh throttled da branch em curso — fetch+reset; o Next dev faz o resto. */
async function refreshBranch(rec: PreviewProc): Promise<void> {
  if (Date.now() - rec.lastPull < 20_000) return;
  rec.lastPull = Date.now();
  const dir = join(APPS_ROOT, rec.slug);
  await spawnPromise("git", ["-C", dir, "fetch", "--depth", "1", "origin", rec.branch]).catch(() => {});
  await spawnPromise("git", ["-C", dir, "reset", "--hard", `origin/${rec.branch}`]).catch(() => {});
}

async function spawnPreview(slug: string, branch = "main"): Promise<{ port: number; ready: boolean }> {
  const app = await loadApp(slug);
  if (!app) throw new Error(`preview: app ${slug} não existe`);
  if (!app.github_repo) throw new Error(`preview: ${slug} sem github_repo`);

  const port = nextPort();
  usedPorts.add(port);
  await updateStatus(app.id, "a_arrancar", port);

  const dir = join(APPS_ROOT, slug);
  await mkdir(dir, { recursive: true });

  const alreadyCloned = await access(join(dir, ".git")).then(() => true).catch(() => false);

  console.log(`[preview:${slug}] a arrancar em porta ${port} · branch=${branch} · ${alreadyCloned ? "pull" : "clone"} de ${app.github_repo}`);
  try {
    // C1.2: SEMPRE a branch pedida — fetch + checkout + reset a origin/<branch>.
    if (alreadyCloned) {
      await spawnPromise("git", ["-C", dir, "fetch", "origin", branch]);
      await spawnPromise("git", ["-C", dir, "checkout", "-B", branch, `origin/${branch}`]);
      await spawnPromise("git", ["-C", dir, "reset", "--hard", `origin/${branch}`]);
    } else {
      await cleanWorktree(""); // no-op para tmp — só garante que o path base existe
      await spawnPromise("git", ["clone", "--branch", branch, "--single-branch", authedRepoUrl(app.github_repo), dir]);
    }
    // Install deps (idempotente — npm ci usa lockfile; senão npm install).
    // SELF-HEAL: um OOM a meio de `npm install` deixa package-lock.json
    // truncado no volume (visto 2026-07-03: `npm ci` imprimia o usage e
    // falhava para sempre). Se o ci falhar, apaga o lock e regenera.
    const hasLock = await access(join(dir, "package-lock.json")).then(() => true).catch(() => false);
    if (hasLock) {
      await spawnPromise("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir }).catch(async () => {
        console.warn(`[preview:${slug}] npm ci falhou — lock possivelmente corrupto; a regenerar com npm install`);
        await rm(join(dir, "package-lock.json"), { force: true });
        await rm(join(dir, "node_modules"), { recursive: true, force: true });
        await spawnPromise("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
      });
    } else {
      await spawnPromise("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
    }
  } catch (e) {
    usedPorts.delete(port);
    await updateStatus(app.id, "erro", null, e instanceof Error ? e.message : String(e));
    throw e;
  }

  // Spawn `next dev` — usa `npm run dev` para respeitar scripts do repo.
  const proc = spawn("npm", ["run", "dev", "--", "--port", String(port), "--hostname", "0.0.0.0"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolveReady: () => void;
  let rejectReady: (e: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  const rec: PreviewProc = { slug, appId: app.id, port, proc, startedAt: Date.now(), lastActive: Date.now(), ready: false, readyPromise, branch, lastPull: Date.now() };
  running.set(slug, rec);

  // Deteta "Ready" na stdout do Next para saber que aceita conexões.
  proc.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    if (!rec.ready && (/Ready in/.test(s) || /Local:\s+http/.test(s))) {
      rec.ready = true;
      updateStatus(app.id, "ativo", port).catch(() => {});
      console.log(`[preview:${slug}] READY (porta ${port})`);
      resolveReady();
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    // Alguns builds do Next imprimem "Ready" em stderr — apanha na mesma.
    if (!rec.ready && /Ready in/.test(s)) {
      rec.ready = true;
      updateStatus(app.id, "ativo", port).catch(() => {});
      resolveReady();
    }
  });
  proc.on("exit", (code) => {
    console.log(`[preview:${slug}] exit code=${code}`);
    running.delete(slug);
    usedPorts.delete(port);
    updateStatus(app.id, "parado", null).catch(() => {});
    if (!rec.ready) rejectReady(new Error(`dev server saiu com code=${code} antes de READY`));
  });

  // Timeout de 90s para READY.
  const readyTimeout = new Promise<void>((_, rej) => setTimeout(() => rej(new Error("timeout à espera de READY (90s)")), 90000));
  try {
    await Promise.race([readyPromise, readyTimeout]);
  } catch (e) {
    stop(slug);
    throw e;
  }

  return { port, ready: true };
}

export function stop(slug: string): void {
  const rec = running.get(slug);
  if (!rec) return;
  console.log(`[preview:${slug}] a parar`);
  try { rec.proc.kill("SIGTERM"); } catch { /* já morreu */ }
  running.delete(slug);
  usedPorts.delete(rec.port);
  updateStatus(rec.appId, "parado", null).catch(() => {});
}

export function touch(slug: string): void {
  const rec = running.get(slug);
  if (rec) rec.lastActive = Date.now();
}

/** Devolve porta se dev server para esse slug está ready — usado pelo router.
 *  C1.2: com `branch`, só devolve se o servidor está NA branch certa. */
export function portOf(slug: string, branch?: string): number | null {
  const rec = running.get(slug);
  if (!rec?.ready) return null;
  if (branch && rec.branch !== branch) return null;
  return rec.port;
}

/** Idle sweeper — corre a cada 60s no index.ts. */
export function sweepIdle(): void {
  const now = Date.now();
  for (const [slug, rec] of running) {
    if (now - rec.lastActive > IDLE_TIMEOUT_MS) {
      console.log(`[preview:${slug}] idle > 20min · parar`);
      stop(slug);
    }
  }
}

async function loadApp(slug: string): Promise<{ id: string; github_repo: string | null } | null> {
  const { data } = await supabase.from("studio_apps").select("id, github_repo").eq("slug", slug).maybeSingle();
  return data as { id: string; github_repo: string | null } | null;
}

async function updateStatus(appId: string, status: string, porta: number | null, erro: string | null = null): Promise<void> {
  await supabase.from("studio_previews").upsert({
    app_id: appId,
    status,
    porta,
    url: porta ? `http://127.0.0.1:${porta}` : null,
    erro,
    last_active: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "app_id" });
}
