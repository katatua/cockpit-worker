/**
 * F1 · gerador de resumo Lovable-style.
 *
 * Após cada iteração do agente (sucesso OU falha), pedimos ao Haiku para
 * escrever um cartão estruturado que resume o que aconteceu:
 *
 *   - titulo: verbo passado, 2-6 palavras ("Corrigiu carrinho", "Adicionou página X")
 *   - causa: o que estava errado (só se resolveu bug, opcional)
 *   - fix: o que fez em bullet points
 *   - proximo_passo: o que o user deve testar/esperar
 *
 * Este cartão fica visível na UI como mensagem `tipo=resumo` com estilo
 * distinto (borda esquerda + título grande + secções).
 *
 * Também extrai 1-3 lições para memória por app (F2).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type Resumo = {
  titulo: string;
  causa?: string;
  fix: string[];
  proximo_passo?: string;
  ferramentas_usadas: number;
  aprendizagens: string[]; // para memória (F2)
};

const SYSTEM = `És o narrador do Studio (assistant tipo Lovable).
Recebes o pedido do 0-coder, as tools que o agente usou (nomes + inputs),
e o resultado (sucesso/falha, mensagem final). Devolves JSON com:
- "titulo": 2-6 palavras em português, verbo no passado ("Adicionou...", "Corrigiu...", "Criou...")
- "causa" (opcional): 1 frase clara se resolveste um bug/erro concreto
- "fix": lista de 2-4 bullets curtos do que fizeste (frases inteiras, sem tecnês pesado)
- "proximo_passo" (opcional): 1 frase — o que o user pode ver/testar agora
- "aprendizagens": 1-3 lições curtas (regras) para futuras ordens nesta app
                   Ex.: "Nesta app, os produtos vivem em app/data.ts", "Usar next/image para <img>"
                   Se não houver nada útil, devolve []

Regras rígidas:
- ZERO tecnês pesado no titulo/fix/proximo_passo (sem 'commit', 'branch', 'deploy', 'PR')
- Aprendizagens PODEM ter termos técnicos (é para o agente ler no futuro)
- Português europeu. Frases inteiras.
- Se tudo falhou, o titulo começa por "Tentei..." e o proximo_passo sugere reformulação.

Responde SÓ com JSON válido. Sem markdown fence.`;

export async function gerarResumo(
  pedido: string,
  toolsUsadas: Array<{ name: string; input: unknown }>,
  finalText: string,
  sucesso: boolean,
  apiKey: string,
): Promise<{ resumo: Resumo; tokensUsed: number } | null> {
  try {
    const toolsSummary = toolsUsadas.slice(0, 30).map((t) => {
      const name = t.name.replace(/^mcp__/, "");
      const preview = JSON.stringify(t.input ?? {}).slice(0, 120);
      return `- ${name} ${preview}`;
    }).join("\n");

    const userMsg = `Pedido do 0-coder:
"${pedido.slice(0, 500)}"

Estado: ${sucesso ? "SUCESSO" : "FALHOU"}
Ferramentas usadas (${toolsUsadas.length}):
${toolsSummary}

Mensagem final do agente:
${(finalText || "(sem texto final)").slice(0, 800)}`;

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-fable-5",
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { content: { type: string; text: string }[]; usage: { input_tokens: number; output_tokens: number } };
    const textBlock = j.content.find((c) => c.type === "text");
    if (!textBlock) return null;
    const stripped = textBlock.text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(stripped) as Partial<Resumo>;
    return {
      resumo: {
        titulo: parsed.titulo ?? (sucesso ? "Concluiu" : "Não conseguiu concluir"),
        causa: parsed.causa,
        fix: Array.isArray(parsed.fix) ? parsed.fix.slice(0, 5) : [],
        proximo_passo: parsed.proximo_passo,
        ferramentas_usadas: toolsUsadas.length,
        aprendizagens: Array.isArray(parsed.aprendizagens) ? parsed.aprendizagens.slice(0, 3) : [],
      },
      tokensUsed: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0),
    };
  } catch {
    return null;
  }
}
