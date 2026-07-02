/**
 * Wrapper do @anthropic-ai/claude-agent-sdk.
 *
 * ATIVO: corre `query()` com allowedTools mínimas + permissionMode='acceptEdits'
 *   (o worker está no worktree, é seguro aceitar edits). Captura tokens e
 *   texto final do agente. Se falha, propaga (o caller marca ordem falhou).
 *
 * INVARIANTES:
 *   - Segredos: só ANTHROPIC_API_KEY como env; SDK usa-o automaticamente.
 *   - Fail-closed: `Bash` restrito ao cwd; tools fora da whitelist rejeitadas
 *     pelo próprio SDK (não são passadas em allowedTools).
 *   - Sem tools de rede (WebFetch/WebSearch) — o worker não navega, escreve.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";

export type AgentRun = {
  finalText: string;
  tokensUsed: number;
  sessionId: string | null;
};

export type AgentInput = {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  mode: "build" | "chat"; // build edita; chat só lê
  resumeSessionId?: string | null;
};

export async function runAgent(input: AgentInput): Promise<AgentRun> {
  const allowedTools = input.mode === "chat"
    ? ["Read", "Glob", "Grep"]
    : ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

  process.env.ANTHROPIC_API_KEY = CONFIG.ANTHROPIC_API_KEY;

  let finalText = "";
  let tokensUsed = 0;
  let sessionId: string | null = null;

  for await (const msg of query({
    prompt: input.userPrompt,
    options: {
      cwd: input.cwd,
      allowedTools,
      permissionMode: input.mode === "chat" ? "plan" : "acceptEdits",
      systemPrompt: input.systemPrompt,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    },
  })) {
    const m = msg as SDKMessage & Record<string, any>;
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id ?? null;
    }
    if (m.type === "result") {
      finalText = m.result ?? "";
      // A shape do usage pode variar entre versões; extrai defensivamente.
      const u = m.usage ?? m.total_usage ?? {};
      tokensUsed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    // Guardrail de orçamento: se somarmos passa o teto, aborta.
    if (tokensUsed > CONFIG.MAX_TOKENS_PER_ORDER) {
      throw new Error(`orçamento excedido: ${tokensUsed} > ${CONFIG.MAX_TOKENS_PER_ORDER} tokens`);
    }
  }

  return { finalText, tokensUsed, sessionId };
}
