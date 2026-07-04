/**
 * Verificação pontual (correr à mão via `node dist/verify-websearch.js`):
 * prova que o agente do SDK consegue mesmo usar WebSearch e trazer dados REAIS.
 * NÃO é importado pelo index — só corre quando invocado diretamente.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("VERIFY: sem ANTHROPIC_API_KEY"); process.exit(2); }

(async () => {
  let usouWeb = false;
  let finalText = "";
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 90000);
  try {
    for await (const msg of query({
      prompt:
        "Pesquisa na web o estado ATUAL do Mundial de futebol 2026 (hoje). " +
        "Diz em que fase está o torneio agora e nomeia UM resultado real da fase a eliminar. Responde numa frase.",
      options: {
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "default",
        maxTurns: 8,
        model: "claude-fable-5",
        abortController,
        canUseTool: async (_name: string, inp: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: inp }),
      } as Record<string, unknown>,
    })) {
      const m = msg as SDKMessage & Record<string, unknown>;
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content ?? [];
        for (const c of content) {
          if (c.type === "tool_use" && (c.name === "WebSearch" || c.name === "WebFetch")) usouWeb = true;
          if (c.type === "text" && c.text) finalText += c.text;
        }
      }
      if (m.type === "result") finalText = (m as { result?: string }).result || finalText;
    }
  } catch (e) {
    console.error("VERIFY erro:", e instanceof Error ? e.message : String(e));
  }
  clearTimeout(timer);
  console.log("VERIFY usouWeb=" + usouWeb);
  console.log("VERIFY resposta: " + finalText.slice(0, 500).replace(/\s+/g, " ").trim());
  process.exit(usouWeb ? 0 : 1);
})();
