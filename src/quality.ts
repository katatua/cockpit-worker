/**
 * Brief §4.6 · quality gate prova-de-vida.
 *
 * Antes de marcar a ordem `preview_pronto`, o worker verifica que a app não
 * está partida. Versão MVP: link check + asset check via HTTP (sem
 * interações). Playwright completo (clique em cards, CRUD, uploads) fica
 * para F5.2 quando o Chromium estiver instalado no worker.
 *
 * Fluxo:
 *   1. GET no preview URL (rota `/`) — deve responder 200 com HTML válido
 *   2. Extrair `<a href>`, `<link href>`, `<script src>`, `<img src>` internos
 *   3. GET a cada URL interno — deve responder < 400
 *   4. Se qualquer falhar → devolve lista de problemas para o worker escalar
 *
 * Não segue redirects para fora do host (só a app própria).
 *
 * + VÍDEOS YOUTUBE (2026-07-04): os IDs de vídeo vivem no CÓDIGO-FONTE (data.ts,
 *   componentes) e muitas vezes são renderizados client-side — não aparecem no
 *   HTML servidor. Por isso verificamos o WORKTREE (verificarVideos), não só o
 *   HTML. IDs inventados dão "vídeo indisponível" e são chumbados antes de publicar.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type QualityReport = {
  ok: boolean;
  base: string;
  checked: number;
  falhas: { url: string; status: number; motivo: string }[];
};

const CACHE = new Map<string, boolean>();
const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string): Promise<{ status: number; body?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    const body = r.headers.get("content-type")?.includes("text/html") ? await r.text() : undefined;
    return { status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Extrai URLs relativas/absolutas do HTML. Não usa DOM parser — regex simples cobre 95%. */
function extractInternalUrls(html: string, base: URL): string[] {
  const urls = new Set<string>();
  const regexes = [
    /<a[^>]+href=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ];
  for (const re of regexes) {
    for (const m of html.matchAll(re)) {
      const raw = m[1];
      if (!raw || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("#") || raw.startsWith("javascript:")) continue;
      try {
        const u = new URL(raw, base);
        if (u.host === base.host) urls.add(u.toString().split("#")[0]);
      } catch { /* ignora URL malformada */ }
    }
  }
  return [...urls];
}

// --- YouTube: os vídeos embutidos têm de ser REAIS e embutíveis ---
const YT_ID = "[A-Za-z0-9_-]{11}";

/** Extrai IDs de vídeo YouTube de embeds, links watch/youtu.be e thumbnails. */
function extractYouTubeIds(html: string): Set<string> {
  const ids = new Set<string>();
  const res = [
    new RegExp(`youtube(?:-nocookie)?\\.com/embed/(${YT_ID})`, "gi"),
    new RegExp(`youtube\\.com/watch\\?[^"'<> ]*v=(${YT_ID})`, "gi"),
    new RegExp(`youtu\\.be/(${YT_ID})`, "gi"),
    new RegExp(`(?:img\\.youtube\\.com|i\\.ytimg\\.com)/vi/(${YT_ID})/`, "gi"),
  ];
  for (const re of res) for (const m of html.matchAll(re)) ids.add(m[1]);
  return ids;
}

const YT_CACHE = new Map<string, { ok: boolean; motivo: string }>();

/**
 * Verifica um vídeo via oEmbed (sem API key):
 *   200 → existe e é embutível  · 401 → existe mas embedding desativado
 *   404 → não existe (ID inventado — a causa nº1 de vídeos falsos)
 */
async function verifyYouTube(id: string): Promise<{ ok: boolean; motivo: string }> {
  if (YT_CACHE.has(id)) return YT_CACHE.get(id)!;
  const oembed = `https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: { ok: boolean; motivo: string };
  try {
    const r = await fetch(oembed, { signal: ctrl.signal });
    res = r.status === 200 ? { ok: true, motivo: "" }
      : r.status === 401 ? { ok: false, motivo: "embedding desativado (não toca no site)" }
      : (r.status === 404 || r.status === 400) ? { ok: false, motivo: "vídeo não existe (ID inventado)" }
      : { ok: false, motivo: `oembed ${r.status}` };
  } catch (e) {
    res = { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
  YT_CACHE.set(id, res);
  return res;
}

const SRC_IGNORE = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "public"]);
async function walkSrc(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 8 || out.length > 600) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (SRC_IGNORE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkSrc(p, out, depth + 1);
    else if (/\.(tsx?|jsx?|json|mdx?)$/.test(e.name)) out.push(p);
  }
}

/**
 * Verifica os vídeos YouTube referidos no CÓDIGO-FONTE da app (data.ts,
 * componentes). Só padrões inequívocos do YouTube (URLs + campos `youtubeId`/
 * `ytId`) para NÃO chumbar apps boas por engano (ex.: IDs de Vimeo). Cada ID é
 * confirmado por oEmbed. Devolve as falhas para o gate escalar.
 */
export async function verificarVideos(worktree: string): Promise<{ checked: number; falhas: { url: string; status: number; motivo: string }[] }> {
  const files: string[] = [];
  await walkSrc(worktree, files);
  const ids = new Set<string>();
  const fieldRe = new RegExp(`(?:youtube_?id|yt_?id)["']?\\s*[:=]\\s*["'](${YT_ID})["']`, "gi");
  for (const f of files.slice(0, 500)) {
    const content = await readFile(f, "utf8").catch(() => "");
    if (!/youtu/i.test(content)) continue; // salta ficheiros sem vídeos (rápido)
    for (const id of extractYouTubeIds(content)) ids.add(id);
    for (const m of content.matchAll(fieldRe)) ids.add(m[1]);
  }
  const falhas: { url: string; status: number; motivo: string }[] = [];
  let checked = 0;
  const list = [...ids].slice(0, 40);
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (id) => {
      checked++;
      const v = await verifyYouTube(id);
      if (!v.ok) falhas.push({ url: `https://youtu.be/${id}`, status: 0, motivo: `vídeo YouTube ${v.motivo}` });
    }));
  }
  return { checked, falhas };
}

/** Corre o gate. Devolve report; o chamador decide se avança para preview_pronto. */
export async function checkQuality(previewUrl: string, rotas: string[] = ["/"]): Promise<QualityReport> {
  const base = new URL(previewUrl);
  const report: QualityReport = { ok: true, base: base.toString(), checked: 0, falhas: [] };

  // 1) Rota principal
  const home = await fetchWithTimeout(previewUrl).catch((e) => ({ status: 0, error: e.message } as { status: number }));
  report.checked++;
  if (home.status < 200 || home.status >= 400) {
    report.falhas.push({ url: previewUrl, status: home.status, motivo: "rota principal não responde 2xx/3xx" });
    report.ok = false;
    return report; // sem home, não há links para verificar
  }
  const html = (home as { body?: string }).body ?? "";
  if (!html.includes("<html") && !html.includes("<HTML")) {
    report.falhas.push({ url: previewUrl, status: home.status, motivo: "resposta sem HTML válido" });
    report.ok = false;
    return report;
  }

  // 2) URLs internas — no máximo 40 (evita gasto absurdo em apps grandes)
  const urls = extractInternalUrls(html, base).slice(0, 40);

  // 3) HEAD/GET a cada em paralelo (throttled a 6 conexões)
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 6) chunks.push(urls.slice(i, i + 6));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (u) => {
      if (CACHE.has(u)) return;
      report.checked++;
      try {
        const r = await fetchWithTimeout(u);
        CACHE.set(u, true);
        if (r.status >= 400) {
          report.falhas.push({ url: u, status: r.status, motivo: `${r.status} ao GET` });
          report.ok = false;
        }
      } catch (e) {
        report.falhas.push({ url: u, status: 0, motivo: e instanceof Error ? e.message : String(e) });
        report.ok = false;
      }
    }));
  }

  // 4) VÍDEOS YOUTUBE — têm de ser reais e embutíveis (oEmbed, sem API key).
  //    Recolhe o HTML de cada rota descoberta (resolve [id] pelo 1º link do pai)
  //    e verifica cada ID único. IDs inventados dão "vídeo indisponível" no site.
  const htmls = [html];
  for (const rota of rotas) {
    if (!rota || rota === "/") continue;
    let path = rota;
    if (rota.includes("[")) {
      const prefixo = rota.slice(0, rota.indexOf("["));
      const pai = prefixo.replace(/\/$/, "") || "/";
      const rp = await fetchWithTimeout(`${base.origin}${pai === "/" ? "" : pai}`).catch(() => ({ status: 0 } as { status: number; body?: string }));
      const esc = prefixo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = rp.body?.match(new RegExp(`href=["'](${esc}[^"'/][^"']*)["']`, "i"));
      if (!m) continue;
      path = m[1];
    }
    const r = await fetchWithTimeout(`${base.origin}${path}`).catch(() => ({ status: 0 } as { status: number; body?: string }));
    if (r.body) htmls.push(r.body);
  }
  const ytIds = new Set<string>();
  for (const h of htmls) for (const id of extractYouTubeIds(h)) ytIds.add(id);
  const ytList = [...ytIds].slice(0, 30);
  for (let i = 0; i < ytList.length; i += 8) {
    await Promise.all(ytList.slice(i, i + 8).map(async (id) => {
      report.checked++;
      const v = await verifyYouTube(id);
      if (!v.ok) {
        report.falhas.push({ url: `https://youtu.be/${id}`, status: 0, motivo: `vídeo YouTube ${v.motivo}` });
        report.ok = false;
      }
    }));
  }

  return report;
}
