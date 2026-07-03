/**
 * Brief §5 · detetor de loop com mudança de estratégia.
 *
 * Estados possíveis quando uma ordem entra `em_execucao`:
 *   1. Sucesso → preview_pronto (fim)
 *   2. Falha da quality gate ou build → nova iteração com mesma estratégia
 *   3. Mesmo erro 3× → ESTRATÉGIA ALTERNATIVA
 *   4. Todas as estratégias esgotadas → falhou + erro_humano com alternativa
 *
 * Este módulo mantém o estado das tentativas dentro da mesma ordem e devolve
 * qual estratégia usar a seguir. Persiste em `studio_orders.estrategias`
 * (jsonb array de {hash, tentativas, estrategia_atual, timestamp}).
 */

import { createHash } from "node:crypto";
import { supabase } from "./db.js";

export type Estrategia = "padrao" | "simplificar" | "sem_feature_secundaria" | "reescrever_do_zero" | "esgotada";

const ORDEM_ESTRATEGIAS: Estrategia[] = [
  "padrao",
  "simplificar",
  "sem_feature_secundaria",
  "reescrever_do_zero",
];
const MAX_TENTATIVAS_MESMO_ERRO = 3;

type EstrategiaLog = {
  hash: string;        // hash da erro-signature
  motivo_curto: string; // resumo humano do erro
  tentativas: number;   // dentro deste hash
  estrategia: Estrategia;
  timestamp: string;
};

/** Hash estável de uma mensagem de erro. Ignora números/caminhos concretos. */
export function errorSignature(motivo: string): string {
  const normalized = motivo
    .toLowerCase()
    .replace(/\d+/g, "N")
    .replace(/\/[^\s]+/g, "/path")
    .replace(/https?:\/\/[^\s]+/g, "url")
    .slice(0, 400);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Decide qual estratégia usar na próxima iteração DESTE erro.
 *
 * Regra: se o hash é novo, começa em `padrao`. Se é conhecido:
 *   - tentativas < MAX → mesma estratégia (dá mais uma hipótese)
 *   - tentativas >= MAX → avança para a próxima estratégia na ORDEM
 *   - se já bateu na `esgotada` → estratégia é `esgotada` (chamador escala)
 *
 * Persiste o estado atualizado em `studio_orders.estrategias`.
 */
export async function nextEstrategia(orderId: string, motivo: string): Promise<{
  estrategia: Estrategia;
  hash: string;
  tentativas: number;
  esgotada: boolean;
}> {
  const hash = errorSignature(motivo);
  const { data: order } = await supabase.from("studio_orders").select("estrategias, tentativas").eq("id", orderId).maybeSingle();
  const log = ((order?.estrategias as EstrategiaLog[] | null) ?? []).slice();

  const existente = log.find((l) => l.hash === hash);
  let estrategia: Estrategia;
  let tentativas: number;
  if (!existente) {
    estrategia = "padrao";
    tentativas = 1;
    log.push({ hash, motivo_curto: motivo.slice(0, 120), tentativas, estrategia, timestamp: new Date().toISOString() });
  } else {
    existente.tentativas += 1;
    tentativas = existente.tentativas;
    if (tentativas > MAX_TENTATIVAS_MESMO_ERRO) {
      const idx = ORDEM_ESTRATEGIAS.indexOf(existente.estrategia);
      const seguinte = idx >= 0 && idx < ORDEM_ESTRATEGIAS.length - 1 ? ORDEM_ESTRATEGIAS[idx + 1] : "esgotada";
      existente.estrategia = seguinte;
      existente.tentativas = 1;
      estrategia = seguinte;
      tentativas = 1;
    } else {
      estrategia = existente.estrategia;
    }
    existente.timestamp = new Date().toISOString();
  }

  const totalTentativas = ((order?.tentativas as number | null) ?? 0) + 1;
  await supabase.from("studio_orders").update({
    estrategias: log,
    tentativas: totalTentativas,
  }).eq("id", orderId);

  return { estrategia, hash, tentativas, esgotada: estrategia === "esgotada" };
}

/**
 * Traduz uma estratégia para uma instrução curta que se prepende ao
 * userPrompt do agente. O sistema prompt fica igual — a instrução guia
 * a abordagem.
 */
export function estrategiaGuidance(estrategia: Estrategia): string {
  switch (estrategia) {
    case "padrao":
      return "";
    case "simplificar":
      return `IMPORTANTE: Já falhaste 3x nesta abordagem. Muda de estratégia:
1. Simplifica AGORA: entrega uma versão mínima que funcione.
2. Corta features avançadas — regista em DECISIONS.md o que ficou para depois.
3. LEIA os erros anteriores com atenção — não repitas o que já não funcionou.
4. Se precisas de dependência nova, INSTALA-A tu (npm install), não peças ao user.`;
    case "sem_feature_secundaria":
      return `IMPORTANTE: Muitas tentativas falharam. Nova abordagem:
1. Remove QUALQUER feature secundária. Só o núcleo.
2. Se um componente tem 5 partes, entrega só a mais essencial.
3. Se um form tem 8 campos, começa com 2.
4. Fica menor. Sempre é melhor entregar pouco que funcione do que muito partido.`;
    case "reescrever_do_zero":
      return `ÚLTIMA ABORDAGEM: Todas as tentativas anteriores falharam. Refaz do zero:
1. IGNORA o que fizeste antes.
2. Escreve o mínimo absoluto — HTML/CSS puro se preciso, sem componentes.
3. Não uses features complexas do Next/React.
4. Deve funcionar depois do primeiro commit. Sem excepções.`;
    case "esgotada":
      return "";
  }
}

/** Mensagem humana quando esgota — dita ao 0-coder em linguagem de pessoa.
 *  Já não é seco — sugere reformulação concreta baseada no que aconteceu. */
export function esgotadaHumana(motivoOriginal: string): string {
  // Sugere reformulação baseada no tipo de erro
  const sug = /npm|build|next|package/i.test(motivoOriginal)
    ? "Parece que há algum problema de configuração. Podes tentar pedir uma versão mais simples primeiro — sem features que precisem de dependências novas."
    : /url|link|404|broken/i.test(motivoOriginal)
    ? "Os links não estão a apontar bem. Diz-me exactamente que páginas queres e como devem estar ligadas."
    : /form|input|submit/i.test(motivoOriginal)
    ? "Parece que os formulários não estão a ser preenchidos correctamente. Descreve os campos que queres e o que deve acontecer ao submeter."
    : "Divide o pedido em partes mais pequenas — uma peça de cada vez costuma funcionar melhor.";

  return `Tentei várias abordagens (simplificar, cortar features, refazer do zero) mas nenhuma resultou. ${sug}`;
}
