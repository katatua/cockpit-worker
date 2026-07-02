/**
 * Brief §4.2 · interpretação de intenção (input → humano).
 *
 * Recebe o texto cru do 0-coder e devolve UMA frase em humano que resume o
 * que o agente vai fazer, para o card "Avanço?". Usa Haiku direto (não Agent
 * SDK) porque é uma única call rápida e barata.
 *
 * Regras herdadas do brief:
 *   - Zero tecnês. Se necessário, o agente decide detalhes técnicos sozinho
 *     (registados em DECISIONS.md pelo worker no início da execução).
 *   - Nunca faz perguntas ao utilizador. Se falta info, assume o mais razoável.
 *   - A frase começa por "Vou " e acaba com contexto suficiente para o
 *     utilizador decidir avançar (não com "Avanço?" — a UI adiciona).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type InterpretResult = {
  kind: "trabalho" | "conversa";
  intencao: string; // "Vou <verbo> <objeto> <detalhes>."
  resposta?: string; // Se conversa, a resposta direta.
  tokensUsed: number;
};

const SYSTEM_PROMPT = `És o interpretador de pedidos do Studio (uma app tipo Lovable).
O utilizador escreve como fala — pode ser vago ou incompleto. A tua função é:

1. Classificar: 'conversa' (pergunta ou comentário sem trabalho) ou 'trabalho' (quer mudar/criar algo na app).
2. Se 'trabalho': dizer em UMA frase o que vais fazer, em humano.

Regras rígidas:
- ZERO tecnês: sem "commit", "deploy", "branch", "build", "componente", "framework", "CSS", "React", "Next.js", "worktree", "PR", "merge".
- Sê concreto. Se algo é vago, decide tu — nunca perguntas ao utilizador.
- Se falta informação, assume a interpretação mais razoável e regista em DECISIONS depois.
- Frase começa por "Vou " e não acaba em interrogação.
- Máximo ~25 palavras.

Exemplos:
- User: "quero uma lista de tarefas" → { "kind": "trabalho", "intencao": "Vou criar uma lista de tarefas onde podes adicionar, marcar como feitas e apagar." }
- User: "muda o título para Olá" → { "kind": "trabalho", "intencao": "Vou mudar o título principal para 'Olá'." }
- User: "quantas apps posso ter?" → { "kind": "conversa", "resposta": "Podes ter até 5 apps no plano Free e 20 no Pro." }

Responde SÓ com JSON válido no formato { "kind": "trabalho"|"conversa", "intencao": "...", "resposta": "..." }.`;

export async function interpret(texto: string, apiKey: string): Promise<InterpretResult> {
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: texto }],
  };
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`interpret: Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { content: { type: string; text: string }[]; usage: { input_tokens: number; output_tokens: number } };
  const textBlock = j.content.find((c) => c.type === "text");
  if (!textBlock) throw new Error("interpret: sem text block na resposta");

  let parsed: { kind: string; intencao?: string; resposta?: string };
  try { parsed = JSON.parse(textBlock.text); } catch {
    // fallback: usa a resposta como intenção literal se JSON falhar
    parsed = { kind: "trabalho", intencao: textBlock.text.slice(0, 200) };
  }
  const kind = parsed.kind === "conversa" ? "conversa" : "trabalho";
  const intencao = parsed.intencao ?? (kind === "trabalho" ? `Vou tratar de: ${texto.slice(0, 80)}.` : "");
  return {
    kind,
    intencao,
    resposta: parsed.resposta,
    tokensUsed: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0),
  };
}
