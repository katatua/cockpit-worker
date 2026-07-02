/**
 * Wrapper do @anthropic-ai/claude-agent-sdk.
 *
 * ATIVO: corre `query()` com allowedTools + BAI-MCP + permissionMode='acceptEdits'.
 * INVARIANTES:
 *   - Segredos: só ANTHROPIC_API_KEY como env.
 *   - Fail-closed: `Bash` restrito ao cwd; tools fora da whitelist rejeitadas.
 *   - Sem tools de rede próprias (WebFetch/WebSearch) — as capacidades de
 *     rede vêm do BAI-MCP (Brief §4.7: media, scraping, QR, email/SMS).
 *   - Brief §1: SEM teto de tokens. Se explodir, kill-switch do dono.
 *   - Runlog: cada chamada de tool → linha stream=tool (ou stream=mcp para BAI).
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";
import { runlog } from "./db.js";

export type AgentRun = {
  finalText: string;
  tokensUsed: number;
  sessionId: string | null;
  mcpToolsFaltantes: string[]; // tools que o agente tentou usar e o BAI-MCP não expõe
};

export type AgentInput = {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  mode: "build" | "chat";
  resumeSessionId?: string | null;
  orderId?: string; // para escrever no runlog
};

export async function runAgent(input: AgentInput): Promise<AgentRun> {
  const allowedToolsBase = input.mode === "chat"
    ? ["Read", "Glob", "Grep"]
    : ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

  process.env.ANTHROPIC_API_KEY = CONFIG.ANTHROPIC_API_KEY;

  // Brief §4.7: BAI-MCP é o tool bus. Adicionamos como server MCP HTTP com
  // token no header. Se BAI_MCP_URL não estiver configurado, corremos sem
  // tools MCP (o agente responde honestamente que não tem essa capacidade).
  const baiUrl = process.env.BAI_MCP_URL;
  const baiSecret = process.env.BAI_MCP_SECRET;
  const mcpServers = baiUrl && baiSecret ? {
    "bai": {
      type: "http" as const,
      url: baiUrl,
      headers: { authorization: `Bearer ${baiSecret}` },
    },
  } : undefined;

  let finalText = "";
  let tokensUsed = 0;
  let sessionId: string | null = null;
  const mcpToolsFaltantes: string[] = [];

  for await (const msg of query({
    prompt: input.userPrompt,
    options: {
      cwd: input.cwd,
      allowedTools: allowedToolsBase,
      permissionMode: input.mode === "chat" ? "plan" : "acceptEdits",
      systemPrompt: input.systemPrompt,
      ...(mcpServers ? { mcpServers } : {}),
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    },
  })) {
    const m = msg as SDKMessage & Record<string, unknown>;

    if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
      sessionId = ((m as { session_id?: string }).session_id) ?? null;
    }

    // Runlog: cada ação (tool call) escreve no terminal do admin.
    if (m.type === "assistant" && input.orderId) {
      const content = (m as { message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      for (const c of content) {
        if (c.type === "tool_use" && c.name) {
          const isMcp = c.name.startsWith("mcp__");
          const stream = isMcp ? "mcp" : "tool";
          const preview = JSON.stringify(c.input ?? {}).slice(0, 180);
          runlog(input.orderId, stream as "tool" | "info", `${c.name} ${preview}`).catch(() => {});
        }
      }
    }

    // Detecta tool_result de MCP com erro (ex: capacidade não existe).
    if (m.type === "user" && input.orderId) {
      const content = (m as { message?: { content?: Array<{ type: string; is_error?: boolean; content?: unknown; tool_use_id?: string }> } }).message?.content ?? [];
      for (const c of content) {
        if (c.type === "tool_result" && c.is_error) {
          const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content).slice(0, 200);
          runlog(input.orderId, "stderr", `tool erro: ${text}`).catch(() => {});
          // Se referência a tool desconhecida, guarda-a para o painel do dono.
          const match = /tool\s+["']?(mcp__[a-z0-9_-]+)["']?\s+not\s+found/i.exec(text);
          if (match) mcpToolsFaltantes.push(match[1]);
        }
      }
    }

    if (m.type === "result") {
      finalText = ((m as { result?: string }).result) ?? "";
      const u = ((m as { usage?: Record<string, number>; total_usage?: Record<string, number> }).usage
        ?? (m as { total_usage?: Record<string, number> }).total_usage
        ?? {}) as Record<string, number>;
      tokensUsed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    // Brief §1: sem teto de tokens. Kill-switch do dono corta processos novos.
  }

  return { finalText, tokensUsed, sessionId, mcpToolsFaltantes };
}
