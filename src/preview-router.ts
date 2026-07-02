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

  // Se dev server já está ready, proxy directo. Senão, tenta arrancar em background
  // e devolve o Vercel preview URL como fallback imediato.
  let port = portOf(slug);
  if (!port) {
    // Fire-and-forget: começa o dev server; o próximo request usa-o.
    ensurePreview(slug).catch((e) => console.warn(`[preview:${slug}] arranque falhou: ${e.message}`));
    const vercel = await lastVercelPreview(slug);
    if (vercel) {
      // Redirect 302 para o Vercel URL, preservando o rest do path (sem o /?t=…).
      url.searchParams.delete("t");
      const suffix = url.pathname + (url.search === "?" ? "" : url.search);
      res.writeHead(302, { location: `${vercel}${suffix === "/" ? "" : suffix}` });
      res.end();
      return;
    }
    sendJson(res, 503, { error: "preview a arrancar; tenta em ~30s" });
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
