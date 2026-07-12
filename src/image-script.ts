/**
 * Cópia CANÓNICA do gerador de imagens (scripts/studio-image.mjs).
 *
 * FONTE DE VERDADE: cockpit/lib/studio/scaffold.ts (STUDIO_IMAGE_SCRIPT). Este
 * ficheiro é uma cópia sincronizada porque o worker e o cockpit são deploys
 * separados. O worker reescreve o script no worktree no arranque de CADA ordem
 * (process.ts), para que apps criadas ANTES da versão paralela/modelos também
 * passem a usar fal.ai+Replicate em paralelo e a escolha de modelo — não só as
 * apps novas. Se editares o script no scaffold, sincroniza aqui.
 */
export const STUDIO_IMAGE_SCRIPT = `#!/usr/bin/env node
// Gera imagens reais com FLUX schnell. fal.ai + Replicate em paralelo no lote.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const FAL = process.env.FAL_KEY;
const REPL = process.env.REPLICATE_API_TOKEN;
if (!FAL && !REPL) { console.error("Sem FAL_KEY nem REPLICATE_API_TOKEN — nao gero imagens falsas."); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fal.ai desliga-se sozinho se a conta ficar sem saldo (403) — evita N chamadas 403.
let falOff = !FAL;

// 2026-07-13: fetch COM timeout. Sem isto, um pedido pendurado (blip de rede ou
// provedor a estagnar) bloqueava um worker do pool PARA SEMPRE — e o Promise.all
// do lote esperava por ele, travando a build inteira (visto: ~6min parado com o
// fal.ai a responder 200/838ms noutros pedidos). Agora um pedido lento aborta e
// o item cai para o outro provedor (ver emPoolMulti). fal ~1s, pro ~4s, imagen
// ~13s, ideogram ~20s → 45s cobre o pior caso com folga.
const IMG_TIMEOUT_MS = Number(process.env.STUDIO_IMG_TIMEOUT_MS || 45000);
async function fetchT(url, opts, ms = IMG_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...(opts || {}), signal: c.signal }); }
  finally { clearTimeout(t); }
}

// aspect -> image_size do fal.ai
const FAL_SIZE = { "16:9": "landscape_16_9", "9:16": "portrait_16_9", "1:1": "square_hd", "4:5": "portrait_4_3", "3:2": "landscape_4_3", "2:3": "portrait_4_3" };

// Modelos fal.ai por qualidade/velocidade (latências medidas 2026-07-04):
//   schnell ~1s $0.003  — cavalo de batalha, usar para a maioria das imagens
//   pro     ~3.6s        — FLUX 1.1 pro, fidelidade superior: usar no HERO
//   imagen  ~13s         — Google Imagen 4, fotorrealismo topo
//   recraft ~10s         — design/marca/vetor
//   ideogram ~20s        — melhor para TEXTO legível dentro da imagem
const FAL_MODELS = {
  schnell:  { ep: "fal-ai/flux/schnell",     body: (p, a) => ({ prompt: p, image_size: FAL_SIZE[a] || "landscape_16_9", num_images: 1, output_format: "jpeg" }) },
  pro:      { ep: "fal-ai/flux-pro/v1.1",    body: (p, a) => ({ prompt: p, image_size: FAL_SIZE[a] || "landscape_16_9", num_images: 1, output_format: "jpeg" }) },
  imagen:   { ep: "fal-ai/imagen4/preview",  body: (p, a) => ({ prompt: p, aspect_ratio: a || "16:9", num_images: 1 }) },
  recraft:  { ep: "fal-ai/recraft-v3",       body: (p, a) => ({ prompt: p, image_size: FAL_SIZE[a] || "landscape_16_9" }) },
  ideogram: { ep: "fal-ai/ideogram/v3",      body: (p, a) => ({ prompt: p, image_size: FAL_SIZE[a] || "landscape_16_9" }) },
};

async function baixar(url, out) {
  const img = await fetchT(url);
  const buf = Buffer.from(await img.arrayBuffer());
  await mkdir(dirname(out), { recursive: true });
  // Os bytes TÊM de bater com a extensão. O fal.ai devolve JPEG; se o destino é
  // .webp, reencodamos para WEBP genuíno (senão o otimizador do Vercel devolve 400:
  // Content-Type image/webp vs bytes JPEG). RIFF/WEBP já correto → não mexe.
  let bytes = buf;
  const isWebp = buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  if (out.toLowerCase().endsWith(".webp") && !isWebp) {
    try { const sharp = (await import("sharp")).default; bytes = await sharp(buf).webp({ quality: 82 }).toBuffer(); }
    catch (e) { console.warn("[img] sem sharp para reencodar webp (" + (e && e.message) + ") — escrevo bytes crus"); }
  }
  await writeFile(out, bytes);
  return { out, kb: Math.round(bytes.length / 1024) };
}

async function viaFal({ prompt, out, aspect, model }) {
  const m = FAL_MODELS[model] || FAL_MODELS.schnell;
  for (let t = 0; t < 4; t++) {
    const r = await fetchT("https://fal.run/" + m.ep, {
      method: "POST",
      headers: { authorization: "Key " + FAL, "content-type": "application/json" },
      body: JSON.stringify(m.body(prompt, aspect)),
    });
    if (r.status === 403) { falOff = true; throw new Error("fal 403 (saldo esgotado)"); }
    if (r.status === 429) { await sleep(1000 * (t + 1)); continue; }
    const j = await r.json().catch(() => ({}));
    const url = j.images && j.images[0] && j.images[0].url;
    if (!r.ok || !url) throw new Error("fal " + r.status);
    return baixar(url, out);
  }
  throw new Error("fal 429 persistente");
}

async function viaReplicate({ prompt, out, aspect }) {
  if (!REPL) throw new Error("sem REPLICATE_API_TOKEN para reserva");
  // Retry com backoff no 429 (rate limit do Replicate). Sem isto, o lote
  // paralelo estourava o limite e arrastava o build (visto: 64min).
  for (let t = 0; t < 7; t++) {
    const r = await fetchT("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
      method: "POST",
      headers: { authorization: "Bearer " + REPL, "content-type": "application/json", prefer: "wait" },
      body: JSON.stringify({ input: { prompt, aspect_ratio: aspect, output_format: "webp", num_outputs: 1, go_fast: true } }),
    }, 60000);
    if (r.status === 429) { await sleep(2000 * (t + 1) + Math.floor(Math.random() * 800)); continue; }
    const j = await r.json();
    const url = j.output && j.output[0];
    if (!r.ok || !url) throw new Error("FLUX " + r.status + ": " + (j.error || JSON.stringify(j)).toString().slice(0, 160));
    return baixar(url, out);
  }
  throw new Error("FLUX 429 persistente (rate limit)");
}

async function gerar({ prompt, out = "public/images/img.webp", aspect = "16:9", model }) {
  // fal.ai primeiro (respeita o modelo pedido); se falhar e houver Replicate,
  // cai para lá — a reserva é sempre FLUX schnell (o Replicate só tem esse aqui).
  if (!falOff) {
    try { return await viaFal({ prompt, out, aspect, model }); }
    catch (e) { if (!REPL) throw e; }
  }
  return viaReplicate({ prompt, out, aspect });
}

// Provedores disponíveis, cada um com a SUA concorrência. fal.ai é muito mais
// rápido (8 imgs paralelas em ~1s, medido) e leva a maior fatia; o Replicate
// corre EM PARALELO com concorrência baixa para SOMAR capacidade sem estourar
// o seu 429. Combinados, o lote sai mais depressa do que com qualquer um só.
const PROVIDERS = [];
if (FAL) PROVIDERS.push({ nome: "fal", conc: 10, gen: viaFal });
if (REPL) PROVIDERS.push({ nome: "replicate", conc: 2, gen: viaReplicate });

// Pool MULTI-PROVEDOR: fila partilhada, workers de cada provedor puxam o
// próximo item — fal.ai e Replicate trabalham em simultâneo. Se um item falhar
// num provedor, tenta UMA vez no outro antes de desistir. (idx = i++ é atómico
// em JS single-thread, logo dois workers nunca apanham o mesmo item.)
async function emPoolMulti(itens) {
  const res = new Array(itens.length);
  let i = 0;
  const workers = [];
  for (const prov of PROVIDERS) {
    for (let w = 0; w < prov.conc; w++) {
      workers.push((async () => {
        for (;;) {
          const idx = i++;
          if (idx >= itens.length) break;
          try { res[idx] = { ok: true, v: await prov.gen(itens[idx]) }; }
          catch (e) {
            const outro = PROVIDERS.find((p) => p.nome !== prov.nome);
            if (outro) { try { res[idx] = { ok: true, v: await outro.gen(itens[idx]) }; continue; } catch (e2) { res[idx] = { ok: false, e: e2 }; continue; } }
            res[idx] = { ok: false, e };
          }
        }
      })());
    }
  }
  await Promise.all(workers);
  return res;
}

const args = process.argv.slice(2);
if (args[0] === "--batch") {
  const lista = JSON.parse(await readFile(args[1], "utf8"));
  const res = await emPoolMulti(lista);
  let ok = 0;
  res.forEach((x, i) => {
    if (x.ok) { ok++; console.log("OK " + x.v.out + " (" + x.v.kb + "KB)"); }
    else console.error("FALHOU " + (lista[i].out || i) + ": " + x.e.message);
  });
  console.log("lote: " + ok + "/" + lista.length + " imagens");
  process.exit(ok === lista.length ? 0 : 4);
} else {
  // modo único: 4º arg opcional escolhe o modelo (schnell|pro|imagen|recraft|ideogram).
  // Usar 'pro' no HERO para fidelidade superior; o resto fica em schnell (rápido).
  const [prompt, out, aspect, model] = args;
  if (!prompt) { console.error("uso: node scripts/studio-image.mjs \\"prompt\\" caminho.webp [aspect] [modelo]  |  --batch imagens.json"); process.exit(1); }
  try { const v = await gerar({ prompt, out, aspect, model }); console.log("OK " + v.out + " (" + v.kb + "KB, " + (model || "schnell") + ") <- " + prompt.slice(0, 60)); }
  catch (e) { console.error(e.message); process.exit(3); }
}
`;
