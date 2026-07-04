/**
 * C4.2 (delta arquitetural 2026-07-04) · critérios de aceitação.
 *
 * No 1º ciclo de cada ordem, o LLM converte a INTENÇÃO confirmada numa
 * checklist VERIFICÁVEL (textos/elementos que têm de existir na página).
 * A validação é DETERMINÍSTICA: fetch às rotas + presença no HTML.
 * Apanha "página incompleta" — não só "página partida".
 */

import { runlog } from "./db.js";

const API = "https://api.anthropic.com/v1/messages";

export type Criterio = {
  descricao: string;          // em humano, para o runlog/erro
  tipo: "texto" | "elemento"; // texto visível · elemento html (button, form, a…)
  valor: string;              // o texto esperado, ou o tag do elemento
  rota: string;               // onde tem de aparecer ("/" por defeito)
};

const TOOL = {
  name: "definir_criterios",
  description: "Regista os critérios de aceitação verificáveis da intenção",
  input_schema: {
    type: "object" as const,
    properties: {
      criterios: {
        type: "array",
        items: {
          type: "object",
          properties: {
            descricao: { type: "string" },
            tipo: { type: "string", enum: ["texto", "elemento"] },
            valor: { type: "string", description: "Texto EXATO esperado na página, ou nome do elemento html (button, form, a, input, h1…)" },
            rota: { type: "string", description: "Rota onde deve aparecer, ex '/' ou '/sobre'" },
          },
          required: ["descricao", "tipo", "valor", "rota"],
        },
      },
    },
    required: ["criterios"],
  },
};

/** Gera a checklist a partir da intenção (LLM, 1× por ordem). */
export async function gerarAceitacao(intencao: string, apiKey: string): Promise<Criterio[]> {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-fable-5",
      max_tokens: 1500,
      system: `Converte a intenção de uma ordem de construção web numa checklist CURTA
(3-8 itens) de critérios VERIFICÁVEIS por inspeção do HTML:
- tipo "texto": um texto que TEM de aparecer na página (usa palavras da intenção, não inventes)
- tipo "elemento": um elemento que TEM de existir (button, form, a, h1, input…)
Só critérios objetivos. Nada de estética/subjetivo.`,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "definir_criterios" },
      messages: [{ role: "user", content: intencao }],
    }),
  });
  if (!r.ok) throw new Error(`aceitacao: Anthropic ${r.status}`);
  const j = await r.json() as { content: { type: string; input?: { criterios: Criterio[] } }[] };
  const tu = j.content.find((c) => c.type === "tool_use");
  return (tu?.input?.criterios ?? []).slice(0, 8).map((c) => ({ ...c, rota: c.rota || "/" }));
}

/**
 * Resolve rotas dinâmicas (com `[seg]`) a uma instância CONCRETA, seguindo o 1º
 * link do "pai" que entra no segmento. Ex.: `/jogos/[id]` → fetch `/jogos`,
 * apanha `href="/jogos/42"`. Rotas estáticas passam intactas. Sem instância → cai.
 */
async function resolverRotas(previewUrl: string, rotas: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rota of rotas) {
    if (!rota.includes("[")) { out.push(rota); continue; }
    const prefixo = rota.slice(0, rota.indexOf("[")); // ex.: "/jogos/"
    const pai = prefixo.replace(/\/$/, "") || "/";     // ex.: "/jogos"
    const r = await fetch(`${previewUrl}${pai === "/" ? "" : pai}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    const html = r?.ok ? await r.text() : "";
    const esc = prefixo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = html.match(new RegExp(`href=["'](${esc}[^"'/][^"']*)["']`, "i"));
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Valida DETERMINISTICAMENTE a checklist contra o deploy.
 *
 * ROBUSTEZ MULTI-PÁGINA (fix 2026-07-04): um critério passa se for satisfeito na
 * rota ATRIBUÍDA **ou em QUALQUER rota descoberta da app**. O gerador (LLM) só vê
 * o texto da intenção e tende a pôr tudo em "/", mas num site multi-página as
 * features vivem em sub-rotas (comentários em /jogos/[id], tabelas em /grupos).
 * Verificar só "/" dava falsos "página incompleta" e queimava iterações.
 */
export async function validarAceitacao(
  previewUrl: string,
  criterios: Criterio[],
  orderId: string,
  rotasApp: string[] = ["/"],
): Promise<{ ok: boolean; falhas: string[] }> {
  const falhas: string[] = [];
  const cacheHtml = new Map<string, string>();
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

  const fetchHtml = async (rota: string): Promise<string> => {
    if (cacheHtml.has(rota)) return cacheHtml.get(rota)!;
    const r = await fetch(`${previewUrl}${rota === "/" ? "" : rota}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    const html = r?.ok ? await r.text() : "";
    cacheHtml.set(rota, html);
    return html;
  };
  const testaTexto = (html: string, valor: string): boolean => {
    const h = norm(html), v = norm(valor);
    if (h.includes(v)) return true;
    // Tolerância a plural/género PT (classificação↔classificações, o sufixo -ão/-ões
    // é irregular): palavra ÚNICA e longa → tenta também sem os 2 últimos caracteres.
    if (!v.includes(" ") && v.length >= 7 && h.includes(v.slice(0, -2))) return true;
    return false;
  };
  const testa = (html: string, c: Criterio): boolean =>
    c.tipo === "texto"
      ? testaTexto(html, c.valor)
      : new RegExp(`<${c.valor}[\\s>]`, "i").test(html);

  // Conjunto de rotas concretas para o fallback "existe algures na app".
  const rotasConcretas = await resolverRotas(previewUrl, rotasApp.length ? rotasApp : ["/"]);

  for (const c of criterios) {
    const rota = c.rota.startsWith("/") ? c.rota : `/${c.rota}`;
    // 1) rota atribuída pelo gerador
    let passou = testa(await fetchHtml(rota), c);
    // 2) fallback: a feature conta se existir em QUALQUER rota da app
    if (!passou) {
      for (const rc of rotasConcretas) {
        if (rc === rota) continue;
        if (testa(await fetchHtml(rc), c)) { passou = true; break; }
      }
    }
    if (!passou) falhas.push(`${c.descricao} (${c.tipo}: "${c.valor}")`);
  }
  await runlog(orderId, "info", `aceitação: ${criterios.length - falhas.length}/${criterios.length} critérios OK${falhas.length ? " · em falta: " + falhas.slice(0, 3).join("; ") : ""}`);
  return { ok: falhas.length === 0, falhas };
}
