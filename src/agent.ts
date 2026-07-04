/**
 * Wrapper do @anthropic-ai/claude-agent-sdk.
 *
 * ATIVO: corre `query()` com allowedTools + BAI-MCP + permissionMode='acceptEdits'.
 * INVARIANTES:
 *   - Segredos: só ANTHROPIC_API_KEY como env.
 *   - Fail-closed: `Bash` restrito ao cwd; tools fora da whitelist rejeitadas.
 *   - Rede: WebSearch/WebFetch ATIVOS (2026-07-04) para o agente ir buscar
 *     dados REAIS/atuais (resultados desportivos, notícias, preços) em vez de
 *     inventar. Conteúdo web é DADOS não-fiáveis (o prompt proíbe seguir
 *     instruções que lá venham). Restante (media, QR, email/SMS) via BAI-MCP.
 *   - Brief §1: SEM teto de tokens. Se explodir, kill-switch do dono.
 *   - Runlog: cada chamada de tool → linha stream=tool (ou stream=mcp para BAI).
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";
import { runlog, supabase } from "./db.js";
import { humanizeToolUse } from "./humanize.js";

export type AgentRun = {
  finalText: string;
  tokensUsed: number;
  sessionId: string | null;
  mcpToolsFaltantes: string[];
  toolsUsadas: Array<{ name: string; input: unknown }>; // F1 resumo Lovable-style
};

export type AgentInput = {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  mode: "build" | "chat";
  resumeSessionId?: string | null;
  orderId?: string;   // para escrever no runlog
  appId?: string;     // para escrever mensagens atividade
  userId?: string;    // para inserir com user_id preservado
};

export async function runAgent(input: AgentInput): Promise<AgentRun> {
  const allowedToolsBase = input.mode === "chat"
    ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
    : ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

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
  const toolsUsadas: Array<{ name: string; input: unknown }> = [];

  // C3.3: instrumentação do hang — sabemos SEMPRE qual foi o último evento e
  // que tool ficou pendente antes de qualquer silêncio.
  let lastEvent = "init";
  let pendingTool: string | null = null;

  // C3 (delta arquitetural 2026-07-04): o "hang" tinha duas caras —
  //  (a) tool fora da whitelist SEM canUseTool → pedido de permissão que
  //      nunca resolve (corrigido: canUseTool fail-closed responde a TUDO);
  //  (b) trabalho REAL >15min morto pelo TOTAL → tokens=0, result perdido.
  // Novo desenho: IDLE 4min é o detetor de hang (sessão saudável emite
  // sempre); TOTAL sobe para 45min como guarda de custo (custo é telemetria,
  // não travão — §1); maxTurns limita loops de turnos.
  const AGENT_TOTAL_MS = 45 * 60 * 1000;
  const AGENT_IDLE_MS = 240_000;
  const startAt = Date.now();
  let lastMsgAt = Date.now();
  let timedOut = false;
  let timeoutMotivo = "";
  const abortController = new AbortController();
  // DESCOBERTA (instrumentação C3.3 em produção): o "hang" era o idle_4min a
  // matar Bash LONGO e saudável (npm run build leva minutos e o SDK não emite
  // mensagens durante a execução de uma tool). Com tool pendente, o silêncio
  // é ESPERADO — o limite passa a 12 min por tool; sem tool pendente, 4 min.
  const TOOL_PENDING_MS = 12 * 60 * 1000;
  const guard = setInterval(() => {
    const now = Date.now();
    const idleLimit = pendingTool ? TOOL_PENDING_MS : AGENT_IDLE_MS;
    if (now - startAt > AGENT_TOTAL_MS || now - lastMsgAt > idleLimit) {
      timedOut = true;
      timeoutMotivo = now - startAt > AGENT_TOTAL_MS ? "total_45min" : (pendingTool ? `tool_${pendingTool}_12min` : "idle_4min");
      // C3.3: gravar o estado da sessão ANTES de matar — o watchdog deixa de
      // ser rede cega e passa a instrumento de diagnóstico.
      if (input.orderId) {
        const diag = { motivo: timeoutMotivo, last_event: lastEvent, pending_tool: pendingTool, elapsed_s: Math.round((now - startAt) / 1000), session_id: sessionId };
        runlog(input.orderId, "stderr", `WATCHDOG ${timeoutMotivo} · último evento: ${lastEvent} · tool pendente: ${pendingTool ?? "nenhuma"}`).catch(() => {});
        if (input.appId && input.userId) {
          supabase.from("studio_events").insert({
            app_id: input.appId, order_id: input.orderId, user_id: input.userId,
            tipo: "agente.hang", payload: diag,
          }).then(() => {}, () => {});
        }
      }
      abortController.abort();
    }
  }, 5000);

  // C3.1: canUseTool responde a TODAS as tools, SEMPRE — allow explícito para
  // a whitelist (e BAI-MCP), deny IMEDIATO com log para o resto. Fail-closed
  // = negar, nunca esperar. (A ausência disto deixava o SDK à espera de uma
  // permissão interativa que nunca chegava em headless.)
  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>) => {
    const permitida = allowedToolsBase.includes(toolName) || toolName.startsWith("mcp__bai__");
    if (permitida) return { behavior: "allow" as const, updatedInput: toolInput };
    if (input.orderId) runlog(input.orderId, "stderr", `tool NEGADA (fora da whitelist): ${toolName}`).catch(() => {});
    return { behavior: "deny" as const, message: `A tool ${toolName} não está disponível neste ambiente — usa as tools permitidas (${allowedToolsBase.join(", ")}).` };
  };

  // DEADLOCK FIX: o abortController.abort() mata o child process (SIGINT visto
  // no Fly) mas o generator do SDK pode NUNCA terminar — nem yield nem throw —
  // deixando o `for await` pendurado para sempre e o SALVAGE nunca corre.
  // Solução: consumir o iterador numa inner function e fazer Promise.race com
  // um hard timer (AGENT_TOTAL + 60s de grace). Se o timer ganhar, saímos com
  // o que temos; o generator órfão fica pendurado mas o child já morreu.
  const consume = async (): Promise<void> => {
  for await (const msg of query({
    prompt: input.userPrompt,
    options: {
      cwd: input.cwd,
      allowedTools: allowedToolsBase,
      // C3.1: 'plan' em headless podia pender à espera de aprovação do plano;
      // chat passa a 'default' read-only (canUseTool nega escritas na mesma).
      permissionMode: input.mode === "chat" ? "default" : "acceptEdits",
      canUseTool, // C3.1: responde a TUDO, fail-closed
      maxTurns: 200, // C3.2: limite de turnos (loops), nunca de tokens
      systemPrompt: input.systemPrompt,
      abortController,
      model: "claude-fable-5", // LLM do agente (SDK) — configurável
      ...(mcpServers ? { mcpServers } : {}),
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    } as Record<string, unknown>,
  })) {
    lastMsgAt = Date.now(); // qualquer mensagem reset o watchdog de silêncio
    const m = msg as SDKMessage & Record<string, unknown>;
    // C3.3: rasto do último evento (tipo+subtipo) para diagnóstico de hang.
    lastEvent = `${m.type}${(m as { subtype?: string }).subtype ? ":" + (m as { subtype?: string }).subtype : ""}`;

    if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
      sessionId = ((m as { session_id?: string }).session_id) ?? null;
      if (input.orderId) runlog(input.orderId, "info", `sdk:init session=${sessionId ?? "?"}`).catch(() => {});
    }

    // Runlog + mensagens `atividade` humanizadas.
    // Cada tool_use do agente vira uma linha crua no runlog (admin) E uma
    // mensagem no chat do 0-coder (traduzida por humanize.ts).
    if (m.type === "assistant" && input.orderId) {
      const content = (m as { message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }> } }).message?.content ?? [];
      // C2.2: STREAMING real — o texto do assistente entra no chat À MEDIDA
      // que acontece (a sensação Claude Code), não só um resumo a posteriori.
      for (const c of content) {
        if (c.type === "text" && c.text && c.text.trim().length > 2 && input.appId && input.userId) {
          supabase.from("studio_messages").insert({
            app_id: input.appId, order_id: input.orderId, user_id: input.userId,
            autor: "agente", tipo: "texto", conteudo: { text: c.text.trim() },
          }).then((r) => { if (r.error) console.warn(`msg texto stream falhou: ${r.error.message}`); });
        }
      }
      for (const c of content) {
        if (c.type === "tool_use" && c.name) {
          const isMcp = c.name.startsWith("mcp__");
          const stream = isMcp ? "mcp" : "tool";
          const preview = JSON.stringify(c.input ?? {}).slice(0, 180);
          runlog(input.orderId, stream as "tool" | "info", `${c.name} ${preview}`).catch(() => {});
          toolsUsadas.push({ name: c.name, input: c.input ?? {} }); // F1 resumo
          pendingTool = c.name; // C3.3: fica pendente até chegar tool_result

          // Fatia B: humanizar para o chat do 0-coder.
          // Fatia C: adiciona também sub-passo ao plano.p2 (hierárquico).
          if (input.appId && input.userId) {
            const humano = humanizeToolUse(c.name, c.input ?? {});
            if (humano) {
              supabase.from("studio_messages").insert({
                app_id: input.appId, order_id: input.orderId, user_id: input.userId,
                autor: "agente", tipo: "atividade", conteudo: { text: humano },
              }).then((r) => { if (r.error) console.warn(`msg atividade falhou: ${r.error.message}`); });

              // Sub-passo no plano — vai buscar plano actual, adiciona ao p2.
              supabase.from("studio_orders").select("plano").eq("id", input.orderId).single()
                .then((r) => {
                  const p = r.data?.plano as { passos: Array<{ id: string; subpassos?: Array<{ id: string; titulo: string; estado: string }> }> } | null;
                  if (!p) return;
                  const p2 = p.passos.find((x) => x.id === "p2");
                  if (!p2) return;
                  if (!p2.subpassos) p2.subpassos = [];
                  const subId = `p2s${p2.subpassos.length + 1}`;
                  // Se o último subpasso é "em_execucao", marca-o feito.
                  const anterior = p2.subpassos[p2.subpassos.length - 1];
                  if (anterior && anterior.estado === "em_execucao") anterior.estado = "feito";
                  p2.subpassos.push({ id: subId, titulo: humano, estado: "em_execucao" });
                  return supabase.from("studio_orders").update({ plano: p }).eq("id", input.orderId!);
                }).then(() => {}, () => {});
            }
          }
        }
      }
    }

    // Detecta tool_result de MCP com erro (ex: capacidade não existe).
    if (m.type === "user" && input.orderId) {
      const content = (m as { message?: { content?: Array<{ type: string; is_error?: boolean; content?: unknown; tool_use_id?: string }> } }).message?.content ?? [];
      for (const c of content) {
        if (c.type === "tool_result") pendingTool = null; // C3.3: resolvida
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
      if (input.orderId) runlog(input.orderId, "info", `sdk:result ${(m as { subtype?: string }).subtype ?? ""} em ${Math.round((Date.now() - startAt) / 1000)}s`).catch(() => {});
      finalText = ((m as { result?: string }).result) ?? "";
      const u = ((m as { usage?: Record<string, number>; total_usage?: Record<string, number> }).usage
        ?? (m as { total_usage?: Record<string, number> }).total_usage
        ?? {}) as Record<string, number>;
      tokensUsed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    // Brief §1: sem teto de tokens. Kill-switch do dono corta processos novos.
  }
  }; // fim consume()

  // Hard timer: se o iterador não terminar (nem depois do abort), saímos na mesma.
  // O guard interval marca timedOut + aborta o child; este race garante que a
  // função devolve controlo mesmo com o generator pendurado.
  const hardLimitMs = AGENT_TOTAL_MS + 60_000;
  let hardTimer: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<"hard-timeout">((res) => {
    hardTimer = setTimeout(() => { timedOut = true; abortController.abort(); res("hard-timeout"); }, hardLimitMs);
  });
  // Também um timer curto pós-abort: se o guard abortou (timedOut) e o iterador
  // não terminar em 30s, saímos.
  const postAbortExit = new Promise<"post-abort">((res) => {
    const check = setInterval(() => {
      if (timedOut) {
        clearInterval(check);
        setTimeout(() => res("post-abort"), 30_000);
      }
    }, 5000);
  });

  try {
    await Promise.race([consume(), hardTimeout, postAbortExit]);
  } finally {
    clearInterval(guard);
    if (hardTimer) clearTimeout(hardTimer);
  }

  if (timedOut) {
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    throw new Error(`agente demorou muito sem terminar (${elapsed}s)`);
  }

  return { finalText, tokensUsed, sessionId, mcpToolsFaltantes, toolsUsadas };
}
