/**
 * Brief §4.1 · descoberta de rotas do repo.
 *
 * Scan simples do worktree pós-commit para extrair rotas Next.js App Router.
 * Regras:
 *   - Só ficheiros `app/**\/page.tsx` (ou .ts, .jsx, .js)
 *   - Segmentos em [] são placeholders → deixa como está (mostra dinamicamente)
 *   - Grupos () são ignorados no path (Next convenção)
 *   - Ignora __tests__, .next, node_modules
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const IGNORE = new Set(["node_modules", ".next", ".git", "__tests__", ".vercel", "dist"]);

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/^page\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(p);
  }
}

/** Devolve array ordenado de rotas descobertas (ex.: ["/", "/about", "/products/[id]"]). */
export async function discoverRoutes(worktree: string): Promise<string[]> {
  const appDir = join(worktree, "app");
  const s = await stat(appDir).catch(() => null);
  if (!s || !s.isDirectory()) return ["/"];

  const pages: string[] = [];
  await walk(appDir, pages);
  const rotas = new Set<string>();
  for (const p of pages) {
    const rel = relative(appDir, p);
    const dir = rel.replace(/\/page\.[tj]sx?$/, "").replace(/^page\.[tj]sx?$/, "");
    const segs = dir.split("/").filter((s) => s && !/^\(.*\)$/.test(s)); // remove groups
    const path = segs.length === 0 ? "/" : "/" + segs.join("/");
    rotas.add(path);
  }
  if (rotas.size === 0) rotas.add("/");
  return [...rotas].sort((a, b) => a.length - b.length);
}
