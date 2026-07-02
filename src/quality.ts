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
 */

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

/** Corre o gate. Devolve report; o chamador decide se avança para preview_pronto. */
export async function checkQuality(previewUrl: string): Promise<QualityReport> {
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

  return report;
}
