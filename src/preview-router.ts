/**
 * Studio Fatia 3b · router HTTP público do worker.
 *
 * Expõe em porta 8080 (Fly [http_service] → https://cockpit-worker-79fnmw.fly.dev):
 *
 *   GET /health                       — 200 OK; usado por curl e por checks
 *   GET /preview/:slug/*?t=<token>    — proxy para dev server interno (Fatia 3c)
 *                                       ou 302 para o Vercel preview URL (Fatia 3b)
 *
 * Auth gate: query `?t=` é HMAC-SHA256(user_id:slug:expiry, PREVIEW_SECRET).
 * O Cockpit gera o token quando o utilizador abre o Studio; validade curta (1h).
 * Rejeita tokens expirados ou inválidos com 401.
 *
 * WebSocket upgrade (HMR do Next dev): reconhece Upgrade e faz proxy raw via
 * net.createConnection para o dev server interno.
 */

import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { supabase } from "./db.js";
import { ensurePreview, portOf, touch } from "./preview-manager.js";

const PREVIEW_SECRET = process.env.PREVIEW_SECRET ?? "";

/** HMAC-SHA256 sobre "user_id|slug|expiry". Aceita token válido não expirado. */
function verifyToken(token: string | null, slug: string): { ok: boolean; userId?: string; motivo?: string } {
  if (!token) return { ok: false, motivo: "sem token" };
  if (!PREVIEW_SECRET) return { ok: false, motivo: "server sem PREVIEW_SECRET" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, motivo: "token mal formado" };
  const [userId, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return { ok: false, motivo: "token expirado" };
  const expected = createHmac("sha256", PREVIEW_SECRET).update(`${userId}|${slug}|${expiry}`).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
      return { ok: false, motivo: "signature inválida" };
    }
  } catch {
    return { ok: false, motivo: "signature mal formada" };
  }
  return { ok: true, userId };
}

/** Confirma que o user_id no token é dono da app (RLS via service role). */
async function ownsApp(userId: string, slug: string): Promise<boolean> {
  const { data } = await supabase.from("studio_apps").select("id").eq("slug", slug).eq("user_id", userId).maybeSingle();
  return !!data;
}

/** Último preview_url Vercel READY da app — usado como fallback quando o dev
 *  server local ainda não está pronto (ou desligado). Dois queries para evitar
 *  o join estranho do PostgREST tipar-se como recursivo. */
async function lastVercelPreview(slug: string): Promise<string | null> {
  const { data: app } = await supabase.from("studio_apps").select("id").eq("slug", slug).maybeSingle();
  if (!app) return null;
  const { data: order } = await supabase
    .from("studio_orders")
    .select("preview_url")
    .eq("app_id", (app as { id: string }).id)
    .eq("estado", "preview_pronto")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (order as { preview_url: string | null } | null)?.preview_url ?? null;
}

/**
 * C1.1/C1.2: a branch que o dev server deve servir = a da ordem ATIVA da app
 * (em_execucao mais recente com branch). Sem ordem ativa → main (estado
 * publicado). É isto que garante que o utilizador vê a app a ganhar forma.
 */
async function activeBranch(slug: string): Promise<string> {
  const { data: app } = await supabase.from("studio_apps").select("id").eq("slug", slug).maybeSingle();
  if (!app) return "main";
  const { data: order } = await supabase
    .from("studio_orders")
    .select("branch")
    .eq("app_id", (app as { id: string }).id)
    .eq("estado", "em_execucao")
    .not("branch", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (order as { branch: string | null } | null)?.branch ?? "main";
}

function parseSlugPath(url: string): { slug: string; rest: string } | null {
  const m = url.match(/^\/preview\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) return null;
  return { slug: m[1], rest: (m[2] ?? "/") + (m[3] ?? "") };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = parseSlugPath(req.url ?? "");
  if (!parsed) { sendJson(res, 404, { error: "not found" }); return; }
  const { slug, rest } = parsed;

  const url = new URL(rest, "http://localhost");
  const token = url.searchParams.get("t");
  const auth = verifyToken(token, slug);
  if (!auth.ok) { sendJson(res, 401, { error: `auth: ${auth.motivo}` }); return; }
  if (!(await ownsApp(auth.userId!, slug))) { sendJson(res, 403, { error: "não és dono desta app" }); return; }

  // C1: o dev server serve a branch da ordem ativa (não main às cegas).
  const branch = await activeBranch(slug);
  // Se dev server já está ready NA BRANCH CERTA, proxy directo. Senão,
  // arranca em background e devolve estado de carregamento honesto.
  let port = portOf(slug, branch);
  if (!port) {
    // Fire-and-forget: começa o dev server; o próximo request usa-o.
    ensurePreview(slug, branch).catch((e) => console.warn(`[preview:${slug}] arranque falhou: ${e.message}`));
    const vercel = await lastVercelPreview(slug);
    if (vercel) {
      // Redirect 302 para o Vercel URL, preservando o rest do path (sem o /?t=…).
      url.searchParams.delete("t");
      const suffix = url.pathname + (url.search === "?" ? "" : url.search);
      res.writeHead(302, { location: `${vercel}${suffix === "/" ? "" : suffix}` });
      res.end();
      return;
    }
    // HTML humano em vez de JSON cru (o iframe pode carregar isto e mostrar).
    const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>A preparar</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#333;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}
h1{font-weight:400;font-size:1.1rem;margin:.5rem 0}
p{font-size:.85rem;color:#666;margin:0}
.d{display:inline-flex;gap:.4rem;margin-bottom:.75rem}
.d span{width:.4rem;height:.4rem;border-radius:50%;background:#999;animation:p 1.4s infinite}
.d span:nth-child(2){animation-delay:.15s}.d span:nth-child(3){animation-delay:.3s}
@keyframes p{0%,80%,100%{opacity:.2}40%{opacity:1}}
</style></head><body><div>
<div class="d"><span></span><span></span><span></span></div>
<h1>A preparar a pré-visualização</h1><p>Costuma demorar cerca de 30 segundos.</p></div></body></html>`;
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  touch(slug);
  // Proxy HTTP para 127.0.0.1:<port>{rest}
  const target = { hostname: "127.0.0.1", port, path: rest };
  const proxyReq = (await import("node:http")).request({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    console.warn(`[preview:${slug}] proxy erro: ${e.message}`);
    sendJson(res, 502, { error: `dev server não responde: ${e.message}` });
  });
  req.pipe(proxyReq);
}

/** WebSocket upgrade — HMR do Next usa /_next/webpack-hmr como WS. */
function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  const parsed = parseSlugPath(req.url ?? "");
  if (!parsed) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  const { slug, rest } = parsed;

  const url = new URL(rest, "http://localhost");
  const token = url.searchParams.get("t");
  const auth = verifyToken(token, slug);
  if (!auth.ok) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }

  const port = portOf(slug);
  if (!port) { socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }

  touch(slug);
  const upstream = createConnection({ host: "127.0.0.1", port });
  upstream.on("connect", () => {
    const headers = Object.entries(req.headers).flatMap(([k, v]) => Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`) : v !== undefined ? [`${k}: ${v}`] : []);
    upstream.write(`${req.method} ${rest} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  socket.on("error", () => upstream.destroy());
}

export function startRouter(port = 8080): void {
  const server = createHttp(async (req, res) => {
    try {
      if (req.url === "/health") { sendJson(res, 200, { ok: true }); return; }
      if (req.url?.startsWith("/preview/")) { await handlePreview(req, res); return; }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      console.error("router erro:", e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.on("upgrade", handleUpgrade);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Router HTTP em 0.0.0.0:${port} · preview + health`);
  });
}
