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
      system: `Converte a intenção numa checklist CURTA (3-6 itens) de critérios
VERIFICÁVEIS e ROBUSTOS. Verifica RESULTADOS VISÍVEIS ao utilizador, NUNCA
detalhes de IMPLEMENTAÇÃO (a mesma feature pode ser feita de várias formas):
- tipo "texto": um texto/rótulo que o utilizador deve ver (palavras da intenção, não inventes)
- tipo "elemento": SÓ elementos estruturais genéricos e universais — button, form, a, h1, input, table, img. PROIBIDO exigir video, iframe, canvas, svg, audio, progress, meter, dialog ou QUALQUER tag específica de implementação — uma barra de progresso feita com div estilizada é tão válida como <progress> (visto no quiz-portugal: 8 iterações queimadas a exigir a tag literal). Para features visuais usa tipo "texto" semântico, nunca a tag.
- REGRA DE VERIFICABILIDADE (rígida): todos os critérios têm de ser verificáveis na CARGA INICIAL da página, sem interação. PROIBIDO criar critérios sobre estados condicionais que só aparecem DEPOIS de uma ação do utilizador ou de uma falha externa — badges de fallback, toasts de sucesso, mensagens de erro, resultados de pesquisa, conteúdo pós-submit (visto no catalogo-busca: 3 iterações queimadas a exigir um badge que só aparece após pesquisa com fallback). Esses comportamentos são testados pelo smoke, não pela aceitação estática.
Prefere critérios de TEXTO. Poucos e essenciais. Nada de estética/subjetivo nem de COMO está feito por dentro.`,
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
const stripTags = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Fallback SEMÂNTICO (Haiku, barato) para critérios de TEXTO que falham o check
 * determinístico. O gerador pode pedir "Próximos jogos" e a app dizer "por jogar/
 * calendário" — o mesmo conceito com palavras diferentes. Uma re-iteração do
 * agente custa ~10min; isto custa ~2s. Devolve o conjunto de critérios satisfeitos.
 */
async function validarTextoSemantico(reprovados: Criterio[], textoPagina: string, apiKey: string): Promise<Set<Criterio>> {
  const ok = new Set<Criterio>();
  if (!reprovados.length || !textoPagina.trim() || !apiKey) return ok;
  const lista = reprovados.map((c, k) => `${k + 1}. ${c.descricao}`).join("\n");
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: "Verificas se o TEXTO DE UMA PÁGINA satisfaz requisitos, MESMO com palavras diferentes (ex.: 'jogos que faltam' ou 'calendário' satisfazem 'próximos jogos'; 'previsão' satisfaz 'previsão do utilizador'). Só marcas satisfeito se o conceito estiver MESMO presente. Responde SÓ com os números dos requisitos satisfeitos separados por vírgulas, ou 'nenhum'.",
        messages: [{ role: "user", content: `TEXTO DA PÁGINA:\n${textoPagina}\n\nREQUISITOS:\n${lista}` }],
      }),
    });
    if (!r.ok) return ok;
    const j = await r.json() as { content: { type: string; text?: string }[] };
    const txt = j.content.find((c) => c.type === "text")?.text ?? "";
    for (const m of txt.matchAll(/\d+/g)) { const idx = parseInt(m[0], 10) - 1; if (reprovados[idx]) ok.add(reprovados[idx]); }
  } catch { /* sem LLM → mantém-se o veredicto determinístico */ }
  return ok;
}

export async function validarAceitacao(
  previewUrl: string,
  criterios: Criterio[],
  orderId: string,
  rotasApp: string[] = ["/"],
  apiKey?: string,
): Promise<{ ok: boolean; falhas: string[] }> {
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

  const reprovados: Criterio[] = [];
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
    if (!passou) reprovados.push(c);
  }

  // 3) fallback SEMÂNTICO só para os TEXTOS reprovados (evita re-iterações caras
  //    por fraseado diferente). Elementos ficam sempre determinísticos.
  const textoReprovado = reprovados.filter((c) => c.tipo === "texto");
  let satisfeitos = new Set<Criterio>();
  if (textoReprovado.length && apiKey) {
    const textoPagina = [...cacheHtml.values()].map(stripTags).join(" \n ").slice(0, 7000);
    satisfeitos = await validarTextoSemantico(textoReprovado, textoPagina, apiKey);
  }

  const falhas = reprovados.filter((c) => !satisfeitos.has(c)).map((c) => `${c.descricao} (${c.tipo}: "${c.valor}")`);
  await runlog(orderId, "info", `aceitação: ${criterios.length - falhas.length}/${criterios.length} critérios OK${falhas.length ? " · em falta: " + falhas.slice(0, 3).join("; ") : ""}`);
  return { ok: falhas.length === 0, falhas };
}
