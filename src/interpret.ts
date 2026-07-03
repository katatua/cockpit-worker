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
  kind: "trabalho" | "conversa" | "app_nova";
  intencao: string; // "Vou <verbo> <objeto> <detalhes>."
  resposta?: string; // Se conversa, a resposta direta.
  nomeAppSugerido?: string; // Se app_nova, o nome que o agente propõe
  tokensUsed: number;
};

const SYSTEM_PROMPT = `És o interpretador de pedidos do Studio (uma app tipo Lovable).
O utilizador escreve como fala — pode ser vago ou incompleto. A tua função é:

1. Classificar em UM de três:
   - 'conversa': pergunta ou comentário sem trabalho
   - 'trabalho': quer mudar/adicionar algo na app ATUAL
   - 'app_nova': o pedido é obviamente uma app diferente (não uma mudança na atual)
2. Se 'trabalho': dizer em UMA frase o que vais fazer, em humano.
3. Se 'app_nova': propor um nome curto (2-4 palavras) e dizer o que a app faz.

Regras rígidas:
- ZERO tecnês: sem "commit", "deploy", "branch", "build", "componente", "framework", "CSS", "React", "Next.js", "worktree", "PR", "merge".
- Sê concreto. Se algo é vago, decide tu — nunca perguntas ao utilizador.
- Frase começa por "Vou " e não acaba em interrogação.
- Máximo ~25 palavras.

Exemplos:
- User: "muda o título para Olá" → { "kind": "trabalho", "intencao": "Vou mudar o título principal para 'Olá'." }
- User: "quero uma lista de tarefas" (numa app site-hello) → { "kind": "app_nova", "nomeAppSugerido": "Lista de tarefas", "intencao": "Vou criar uma app nova (Lista de tarefas) onde podes adicionar, marcar como feitas e apagar." }
- User: "quantas apps posso ter?" → { "kind": "conversa", "resposta": "Podes ter até 5 apps no plano Free e 20 no Pro." }

Responde SÓ com JSON válido no formato { "kind": "trabalho"|"conversa"|"app_nova", "intencao"?: "...", "resposta"?: "...", "nomeAppSugerido"?: "..." }.`;

export async function interpret(texto: string, apiKey: string): Promise<InterpretResult> {
  const body = {
    model: "claude-fable-5",
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

  // Haiku às vezes envolve o JSON num code fence markdown (```json ... ```).
  // Faz strip do fence antes do parse.
  const rawText = textBlock.text.trim();
  const stripped = rawText
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  let parsed: { kind: string; intencao?: string; resposta?: string; nomeAppSugerido?: string };
  try { parsed = JSON.parse(stripped); } catch {
    // fallback: usa a primeira linha como intenção se JSON continua a falhar
    parsed = { kind: "trabalho", intencao: rawText.split("\n")[0].slice(0, 200) };
  }
  const kind = parsed.kind === "conversa" ? "conversa"
    : parsed.kind === "app_nova" ? "app_nova"
    : "trabalho";
  const intencao = parsed.intencao ?? (kind !== "conversa" ? `Vou tratar de: ${texto.slice(0, 80)}.` : "");
  return {
    kind,
    intencao,
    resposta: parsed.resposta,
    nomeAppSugerido: parsed.nomeAppSugerido,
    tokensUsed: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0),
  };
}
