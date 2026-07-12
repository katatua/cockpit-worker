/**
 * TIER PROFUNDO (2026-07-12) · o Studio como réplica do Claude Code.
 *
 * Em vez de UM agente numa passagem (tier simples), uma app complexa passa por
 * um pipeline multi-agente sobre o MESMO worktree (o filesystem é o estado
 * partilhado — agentes stateless, cada um recebe o contexto no prompt):
 *
 *   A. MAPA DO REPO (determinístico, barato) — árvore + símbolos exportados.   [#6]
 *   B. ARQUITETO (Opus) — decompõe o objetivo em milestones verificáveis,      [#2/#5]
 *      escreve PLAN.md (humano) + .studio/plan.json (máquina).
 *   C. IMPLEMENTADOR (Sonnet) — executa milestone a milestone; `npm run build` [#2]
 *      entre milestones; loop de correção se partir.
 *   D. VERIFICADOR (Opus) — corre build+testes, revê o diff contra a aceitação [#3]
 *      de cada milestone, escreve .studio/verify.json; loop implement↔verify.
 *
 * Sem teto de iterações — orçamento de TEMPO largo (CONFIG.DEEP_BUDGET_MS).
 * Os gates pós-deploy do process.ts mantêm-se como rede de segurança final.
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { runAgent } from "./agent.js";
import { spawnPromise } from "./spawn-helpers.js";
import { supabase, log, runlog, event } from "./db.js";
import { commitAll, hasChanges, runCmd } from "./git.js";
import { waitForPreviewDeploy } from "./vercel.js";

export type Milestone = {
  id: string;
  titulo: string;
  descricao: string;
  ficheiros: string[];
  aceitacao: string[];
};

export type DeepBuildInput = {
  cwd: string;
  objetivo: string;          // order.texto (+ spec aprovada)
  baseSystemPrompt: string;  // as leis + qualidade + contexto da app (reutiliza o do process.ts)
  orderId: string;
  appId: string;
  userId: string;
  vercelProjectId?: string;  // preview incremental: deploy por milestone
  branch?: string;
};

export type DeepBuildResult = {
  finalText: string;
  tokensUsed: number;
  sessionId: string | null;
  mcpToolsFaltantes: string[];
  toolsUsadas: Array<{ name: string; input: unknown }>;
  milestones: Milestone[];
};

const PLAN_PATH = ".studio/plan.json";
const VERIFY_PATH = ".studio/verify.json";
const PROGRESS_PATH = ".studio/progress.json"; // milestones já feitos (para resume)

// Commit+push do progresso (por milestone) — persiste o trabalho na branch da
// ordem, para uma interrupção NÃO recomeçar do zero (retoma daqui). Best-effort.
async function commitPush(cwd: string, orderId: string, msg: string): Promise<string | null> {
  try {
    if (!(await hasChanges(cwd))) return null;
    const sha = await commitAll(cwd, msg);
    await runCmd("git", ["-C", cwd, "push", "--force", "origin", "HEAD"]);
    return sha;
  } catch (e) {
    await runlog(orderId, "stderr", `commit incremental falhou (segue na mesma): ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    return null;
  }
}

// REGRA DE COMUNICAÇÃO (2026-07-12) — a mais importante para o utilizador ver.
// O modo profundo usa papéis "arquiteto/implementador" que tendem a falar como
// engenheiros. Mas o utilizador NÃO é programador e vê o texto AO VIVO. Isto
// força a mesma régua "zero tecnês" do resto do Studio em TODAS as fases.
const COMUNICACAO_UTILIZADOR = `--- COMO FALAS COM O UTILIZADOR (regra rígida, acima do teu papel) ---
Quem lê o teu texto ao vivo NÃO é programador. Fala em português simples, na 1.ª pessoa, dizendo O QUE ele vai ganhar — NUNCA o COMO por dentro. ZERO tecnês: PROIBIDO nomes de tecnologias/ferramentas (Next, React, Tailwind, Supabase, Vercel…) e termos como "store", "schema", "hook", "componente", "API", "endpoint", "estado", "localStorage", "tipos", "build", "commit", "SEO", "rota". Traduz sempre para o que interessa à pessoa. Ex.: em vez de «vou criar o store local-first com useSyncExternalStore», diz «vou preparar onde os teus projetos e tarefas ficam guardados no teu navegador». O raciocínio técnico vive NO CÓDIGO, não no chat.
Isto vale para CADA frase que escreves no chat, INCLUSIVE quando "pensas alto" sobre como vais fazer: NUNCA despejes as tuas decisões/análises técnicas em tecnês (nomes de tecnologias, padrões, ficheiros). Se o pensamento é técnico, ou o guardas para ti e para os ficheiros, ou traduze-lo para o que a pessoa ganha. Uma frase técnica no chat = erro.`;

// DISCIPLINA DE ENGENHARIA (regra de execução do dono) — vale para o CÓDIGO que
// escreves, não para o chat. Builds complexos têm de ficar minuciosamente
// documentados e seguros.
const DISCIPLINA_CODIGO = `--- DISCIPLINA DE CÓDIGO (obrigatória neste build) ---
1. DOCUMENTA minuciosamente: comenta TODA a dependência que introduzes (porquê) e TODA a alteração futura obrigatória, distinguindo claramente ATIVO vs. LEGACY vs. A-MUDAR nos comentários.
2. ESQUELETO DETERMINÍSTICO: a lógica de estrutura vive em código/SQL determinístico; o LLM só na camada de julgamento (redigir/classificar/extrair). Nada de fluxos de risco escondidos.
3. FALHAS TIPADAS E HONESTAS: estados de erro explícitos e tipados; NUNCA sucesso fabricado (o mesmo princípio da lei das integrações).
4. SEGURANÇA NAS MIGRAÇÕES: toda a migração de base de dados nasce com RLS/guard ativo — nunca uma tabela sem política de acesso.
5. RASCUNHO→ATIVO: nada de crítico é "promovido" sem validação; marca o que fica em rascunho.`;

// GOTCHAS conhecidos que já queimaram tempo em builds reais — evita-os À PARTIDA,
// não os descubras por tentativa-e-erro nos gates.
const GOTCHAS = `--- ARMADILHAS CONHECIDAS (evita-as desde o início) ---
1. NUNCA uses window.confirm / window.alert / window.prompt (nem dialogs nativas bloqueantes): o teste automático não consegue passá-las e a ação nunca completa. Usa confirmação em DUAS FASES na própria UI (1º clique arma, 2º confirma), com estado observável (aria-pressed/data-state).
2. IMAGENS na Vercel: o otimizador /_next/image dá 400 em produção para imagens locais (self-fetch interno). Configura no next.config \`images: { unoptimized: true }\` (as webp geradas já são pequenas e pré-comprimidas) — evita a classe de bug toda. Nunca deixes o default que pede w=3840.
3. BUILD: corre \`npm run build\` UMA vez, no fim do milestone, para confirmar verde — não após cada edição de documentação (é desperdício).
4. Controlos interativos (botões/tabs/filtros) expõem SEMPRE o estado à máquina (aria-pressed/aria-selected/data-state) — senão o gate marca-os "não-testáveis".`;

// --- #6 · MAPA DO REPO (determinístico) -----------------------------------
// Árvore de ficheiros de código + símbolos exportados por ficheiro. Barato e
// fiável (sem LLM). Dá ao arquiteto/implementador a "forma" do codebase sem
// ter de ler tudo — o equivalente ao meu grep-first.
const IGNORE_DIRS = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "build", ".studio", "coverage", ".turbo"]);
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|css|json|md|sql)$/;

async function walk(dir: string, root: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6 || out.length > 600) return;
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(full, root, out, depth + 1); }
    else if (CODE_EXT.test(e.name)) out.push(path.relative(root, full));
  }
}

async function repoMap(worktree: string): Promise<string> {
  const files: string[] = [];
  await walk(worktree, worktree, files);
  files.sort();
  const linhas: string[] = [];
  for (const rel of files.slice(0, 400)) {
    let simbolos = "";
    try {
      const st = await stat(path.join(worktree, rel));
      if (st.size < 60_000 && /\.(tsx?|jsx?|mjs)$/.test(rel)) {
        const src = await readFile(path.join(worktree, rel), "utf8");
        const syms = [...src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/g)]
          .map((m) => m[1]).slice(0, 12);
        if (syms.length) simbolos = ` → ${syms.join(", ")}`;
      }
    } catch { /* ignora */ }
    linhas.push(`  ${rel}${simbolos}`);
  }
  return `MAPA DO REPO (${files.length} ficheiros de código; símbolos exportados após →):\n${linhas.join("\n")}`;
}

// --- helpers ---------------------------------------------------------------
function parseJsonLoose<T>(raw: string): T | null {
  const s = raw.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try { return JSON.parse(s) as T; } catch { /* tenta extrair o 1º bloco { } ou [ ] */ }
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]) as T; } catch { return null; } }
  return null;
}

async function buildOk(worktree: string): Promise<{ ok: boolean; erro: string }> {
  try {
    await spawnPromise("npm", ["run", "build"], { cwd: worktree });
    return { ok: true, erro: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, erro: msg.slice(-1600) }; // a cauda do log tem o erro real
  }
}

// --- pipeline --------------------------------------------------------------
export async function runDeepBuild(input: DeepBuildInput): Promise<DeepBuildResult> {
  const { cwd, objetivo, baseSystemPrompt, orderId, appId, userId, vercelProjectId, branch } = input;
  let primeiroPreview = true; // preview incremental: anuncia o link na 1ª vez
  const t0 = Date.now();
  let tokens = 0;
  let sessionId: string | null = null;
  const mcpFaltantes: string[] = [];
  const tools: Array<{ name: string; input: unknown }> = [];
  const restante = () => CONFIG.DEEP_BUDGET_MS - (Date.now() - t0);

  const acc = (r: Awaited<ReturnType<typeof runAgent>>) => {
    tokens += r.tokensUsed;
    if (r.sessionId) sessionId = r.sessionId;
    mcpFaltantes.push(...r.mcpToolsFaltantes);
    tools.push(...r.toolsUsadas);
  };

  await mkdir(path.join(cwd, ".studio"), { recursive: true });

  // --- A · mapa do repo ---
  const mapa = await repoMap(cwd);

  // RESUME (2026-07-12): se a branch da ordem foi clonada com um plano já escrito
  // (.studio/plan.json — o process.ts clona a branch da própria ordem quando ela
  // já existe), RETOMAMOS em vez de recomeçar do zero. É o fix do "recomeçou do 0".
  const planoExistente = await readFile(path.join(cwd, PLAN_PATH), "utf8").then((s) => parseJsonLoose<Milestone[]>(s)).catch(() => null);
  const progresso = await readFile(path.join(cwd, PROGRESS_PATH), "utf8").then((s) => { try { return JSON.parse(s) as { done?: string[] }; } catch { return { done: [] }; } }).catch(() => ({ done: [] as string[] }));
  const doneIds = new Set<string>(Array.isArray(progresso.done) ? progresso.done : []);
  const resumindo = !!(planoExistente && Array.isArray(planoExistente) && planoExistente.length > 0);

  let milestones: Milestone[] | null;
  if (resumindo) {
    await runlog(orderId, "info", `deep-build RESUME · ${doneIds.size} fase(s) já feitas — continuo, não recomeço`);
    await log(appId, orderId, userId, "agente", "pensamento", `A retomar de onde fiquei — ${doneIds.size} fase(s) já prontas, não recomeço do zero.`);
    milestones = planoExistente;
  } else {
  await runlog(orderId, "info", `deep-build arranque · budget=${Math.round(CONFIG.DEEP_BUDGET_MS / 60000)}min`);
  await runlog(orderId, "info", `mapa do repo gerado (${mapa.split("\n").length} linhas)`);

  // --- B · arquiteto (Opus) ---
  await log(appId, orderId, userId, "agente", "pensamento", "A planear como vou construir isto, passo a passo…");
  const arquitetoPrompt = [
    baseSystemPrompt,
    COMUNICACAO_UTILIZADOR,
    DISCIPLINA_CODIGO,
    `--- O TEU PAPEL: ARQUITETO ---
És o arquiteto de um build COMPLEXO (nível: app tão sofisticada como o próprio Studio). NÃO escreves código de features agora. A tua função é DECOMPOR o objetivo num plano de MILESTONES incrementais e verificáveis, cada um entregável e testável por si.
1. LÊ o que precisares do repo (Read/Grep) para perceberes o que já existe — usa o MAPA DO REPO abaixo como índice.
2. Pesquisa (WebSearch) padrões/bibliotecas quando faça sentido para uma decisão de arquitetura sólida.
3. Escreve DOIS ficheiros:
   - "PLAN.md" (humano): visão, decisões de arquitetura, e a lista de milestones.
   - "${PLAN_PATH}" (máquina): um ARRAY JSON de milestones. Cada milestone:
     { "id": "m1", "titulo": "curto e SEM TECNÊS — o UTILIZADOR vê isto no chat (ex.: 'Guardar os teus projetos e tarefas', NÃO 'Fundação de dados & store local-first')", "descricao": "técnico e concreto ao nível de ficheiros/rotas/tabelas — isto é INTERNO, o utilizador não vê", "ficheiros": ["caminhos prováveis"], "aceitacao": ["critérios VISÍVEIS/testáveis de que este milestone ficou feito"] }
REGRAS: entre 3 e ${CONFIG.DEEP_MAX_MILESTONES} milestones, ordenados por dependência (fundação → features → polish). Cada um pequeno o suficiente para um agente o fazer e o build ficar verde no fim. Inclui SEMPRE um milestone final de integração/verificação. Pensa como engenheiro sénior: schema de dados primeiro, depois APIs, depois UI, depois SEO/polish. Não inventes segredos (segue a lei das integrações). Termina quando ${PLAN_PATH} estiver escrito e válido.`,
    `\n\n${mapa}`,
    `\n\nOBJETIVO A DECOMPOR:\n${objetivo}`,
  ].join("\n\n");

  const rArq = await runAgent({
    cwd, systemPrompt: arquitetoPrompt, userPrompt: "Desenha a arquitetura e escreve PLAN.md + " + PLAN_PATH + " agora.",
    mode: "build", orderId, appId, userId, model: CONFIG.WORKER_MODEL_ARCHITECT, idleMs: 600_000,
  });
  acc(rArq);

  milestones = (await readFile(path.join(cwd, PLAN_PATH), "utf8").then((s) => parseJsonLoose<Milestone[]>(s)).catch(() => null)) ?? null;
  if (!milestones || !Array.isArray(milestones) || milestones.length === 0) {
    // Degrada com honestidade: sem plano estruturado, cai para 1 milestone único.
    await runlog(orderId, "stderr", "arquiteto não produziu plano válido — a degradar para milestone único");
    milestones = [{ id: "m1", titulo: "Construir o objetivo", descricao: objetivo, ficheiros: [], aceitacao: ["A app cumpre o objetivo pedido"] }];
  }
  } // fim do else (arquiteto fresh)
  // Normaliza — o arquiteto (LLM) pode omitir campos; sem isto um `.map` de
  // aceitacao/ficheiros indefinido rebentava o pipeline inteiro.
  milestones = milestones.slice(0, CONFIG.DEEP_MAX_MILESTONES).map((m, i) => ({
    id: typeof m.id === "string" && m.id ? m.id : `m${i + 1}`,
    titulo: typeof m.titulo === "string" && m.titulo ? m.titulo : `Fase ${i + 1}`,
    descricao: typeof m.descricao === "string" ? m.descricao : "",
    ficheiros: Array.isArray(m.ficheiros) ? m.ficheiros : [],
    aceitacao: Array.isArray(m.aceitacao) ? m.aceitacao : [],
  }));
  const planoMs: Milestone[] = milestones ?? [];
  await supabase.from("studio_orders").update({ plano_build: planoMs }).eq("id", orderId);
  if (!resumindo) {
    await event(appId, orderId, userId, "deep.plano", { milestones: planoMs.length });
    await log(appId, orderId, userId, "agente", "texto", `Vou construir isto em ${planoMs.length} passos: ${planoMs.map((m) => m.titulo).join(" · ")}.`);
    // Persiste o plano na branch da ordem — o resume depende disto existir no git.
    await commitPush(cwd, orderId, `deep: plano (${planoMs.length} fases)`);
  }

  // --- C+D · implementar cada milestone, com verificação por milestone ---
  for (let i = 0; i < planoMs.length; i++) {
    const m = planoMs[i];
    if (doneIds.has(m.id)) { await runlog(orderId, "info", `milestone ${m.id} já feito — salto (resume)`); continue; }
    if (restante() < 4 * 60 * 1000) {
      await runlog(orderId, "stderr", `orçamento de tempo quase esgotado — paro no milestone ${i + 1}/${planoMs.length} (hand-off honesto)`);
      break;
    }
    await log(appId, orderId, userId, "agente", "pensamento", `Fase ${i + 1}/${planoMs.length}: ${m.titulo}`);
    await runlog(orderId, "info", `milestone ${m.id} (${i + 1}/${planoMs.length}): ${m.titulo}`);
    // Mapa FRESCO desta fase (estrutura + símbolos já construídos) — evita que o
    // implementador re-leia a app inteira do zero em cada milestone.
    const mapaAtual = await repoMap(cwd);

    const feitos = planoMs.slice(0, i).map((x) => `✓ ${x.titulo}`).join("\n") || "(nenhum ainda)";
    const implPrompt = [
      baseSystemPrompt,
      COMUNICACAO_UTILIZADOR,
      DISCIPLINA_CODIGO,
      GOTCHAS,
      `--- O TEU PAPEL: IMPLEMENTADOR ---
Estás a construir UM milestone de um plano maior, sobre a app que já existe no worktree. Faz SÓ este milestone, completo e com o build verde. Segue as leis de qualidade/honestidade acima (edições cirúrgicas, integrações honestas, imagens reais, multi-página+SEO, etc.). Lê o PLAN.md e ${PLAN_PATH} para o contexto global.
MILESTONES JÁ FEITOS (não os refaças):\n${feitos}
MILESTONE ATUAL (${m.id}): ${m.titulo}
Descrição: ${m.descricao}
Ficheiros prováveis: ${m.ficheiros.join(", ") || "(decide tu)"}
Critérios de aceitação deste milestone:\n${m.aceitacao.map((a) => `- ${a}`).join("\n")}
COMUNICA COMO O ARQUITETO (regra importante — não caias em "modo mecânico"): a comunicação NÃO pode empobrecer só porque agora estás a codificar. ANTES de começar, diz numa frase HUMANA o que esta fase traz ao utilizador e a decisão que mais importa nela. À MEDIDA que avanças, narra o RACIOCÍNIO interessante em 1.ª pessoa e linguagem simples (o que estás a construir e porquê, o que ligaste ao quê) — NÃO narres "a ler este ficheiro, a ler aquele"; essa atividade mecânica já é mostrada à parte. O utilizador quer SENTIR o que estás a construir, com a mesma riqueza do plano. Zero tecnês (segue a regra de comunicação acima).
Quando terminares, corre "npm run build" e confirma que fica verde. Só páras com o build verde.
USA o MAPA DO REPO abaixo (estrutura + símbolos já construídos nas fases anteriores) para saberes o que já existe — NÃO re-explores a app inteira ficheiro a ficheiro; lê só o que precisas mesmo de alterar.`,
      `\n\n${mapaAtual}`,
    ].join("\n\n");

    // RESILIÊNCIA (2026-07-12): um milestone que rebente (ex.: timeout do agente)
    // NÃO pode matar o pipeline inteiro — antes salvava-se um parcial de 4/12 como
    // se estivesse pronto. Isola-se cada milestone; o verificador final apanha o
    // que ficou por fazer.
    try {
    const rImpl = await runAgent({
      cwd, systemPrompt: implPrompt, userPrompt: `Implementa o milestone ${m.id}: ${m.titulo}.`,
      mode: "build", orderId, appId, userId, model: CONFIG.WORKER_MODEL_IMPLEMENT, idleMs: 600_000,
    });
    acc(rImpl);

    // build gate + loop de correção (usa Opus na correção — é diagnóstico de bug)
    let bok = await buildOk(cwd);
    let round = 0;
    while (!bok.ok && round < CONFIG.DEEP_MAX_FIX_ROUNDS && restante() > 3 * 60 * 1000) {
      round++;
      await runlog(orderId, "stderr", `build vermelho após ${m.id} — correção ${round}/${CONFIG.DEEP_MAX_FIX_ROUNDS}`);
      await log(appId, orderId, userId, "agente", "atividade", `A corrigir um erro de compilação (${m.titulo})…`);
      const fixPrompt = [
        baseSystemPrompt,
        COMUNICACAO_UTILIZADOR,
        `--- O TEU PAPEL: CORRETOR (o build está VERMELHO) ---
O "npm run build" falhou depois do milestone "${m.titulo}". Lê o erro REAL abaixo, NOMEIA a causa (L2) e corrige na raiz com o mínimo de mudança (L1/L3). Não teorizes — o erro está aqui:\n\n${bok.erro}`,
      ].join("\n\n");
      const rFix = await runAgent({
        cwd, systemPrompt: fixPrompt, userPrompt: "Corrige o build. Confirma com npm run build.",
        mode: "build", orderId, appId, userId, model: CONFIG.WORKER_MODEL_VERIFY, idleMs: 600_000, // Opus: bug
      });
      acc(rFix);
      bok = await buildOk(cwd);
    }
    await event(appId, orderId, userId, "deep.milestone", { id: m.id, i: i + 1, buildOk: bok.ok, fixRounds: round });
    // CHECKPOINT: marca o milestone feito e COMMITA na branch — se algo
    // interromper a seguir, o resume retoma daqui em vez do zero.
    doneIds.add(m.id);
    await writeFile(path.join(cwd, PROGRESS_PATH), JSON.stringify({ done: [...doneIds] }, null, 1));
    const sha = await commitPush(cwd, orderId, `deep: ${m.titulo}`);
    // PREVIEW INCREMENTAL (2026-07-12): deploya o estado atual e mostra o link já —
    // o utilizador vê a app a CRESCER em vez de um spinner até ao fim. Best-effort.
    if (sha && vercelProjectId && branch) {
      const dep = await waitForPreviewDeploy(vercelProjectId, branch, sha).catch(() => null);
      if (dep?.url) {
        await supabase.from("studio_orders").update({ preview_url: dep.url }).eq("id", orderId);
        if (primeiroPreview) {
          primeiroPreview = false;
          await log(appId, orderId, userId, "agente", "texto", `Já podes espreitar a app a ganhar forma: ${dep.url} — continuo a construir por cima, ao vivo.`);
        }
      }
    }
    } catch (e) {
      await runlog(orderId, "stderr", `milestone ${m.id} interrompido: ${e instanceof Error ? e.message.slice(0, 100) : String(e)} — continuo para o próximo`);
      await log(appId, orderId, userId, "agente", "atividade", `A fase "${m.titulo}" demorou de mais; sigo em frente e reviso tudo no fim.`);
    }
  }

  // --- D final · verificador (Opus) sobre o conjunto ---
  if (restante() > 3 * 60 * 1000) {
    await log(appId, orderId, userId, "agente", "pensamento", "A rever tudo contra o plano e a garantir coerência…");
    const verifyPrompt = [
      baseSystemPrompt,
      COMUNICACAO_UTILIZADOR,
      DISCIPLINA_CODIGO,
      GOTCHAS,
      `--- O TEU PAPEL: VERIFICADOR ---
Todos os milestones foram implementados. A tua função é GARANTIR que o conjunto está correto e coerente (não só que compila). Lê ${PLAN_PATH}, corre "npm run build", corre testes se existirem ("npm test" — se falhar por não haver testes, ignora), e revê o diff geral (git diff --stat) contra a aceitação de CADA milestone.
Se encontrares algo em falta ou partido, CORRIGE-O agora (tens autonomia total de edição). Confirma coerência entre partes (dados↔UI↔rotas↔SEO).
No fim escreve "${VERIFY_PATH}" com: { "ok": true|false, "resumo": "<markdown, 1.ª pessoa, estilo engenheiro sénior a entregar — o que construíste por subsistema, decisões técnicas que importam, e pontos de coerência que confirmaste; rico como uma boa mensagem de handoff, NÃO uma frase seca>", "por_fazer": ["o que o DONO tem de fazer, ex. adicionar chaves/configurar um serviço"], "problemas": ["o que ficou por resolver honestamente, se algum"] }.
Termina com o build verde e ${VERIFY_PATH} escrito.`,
    ].join("\n\n");
    const rVer = await runAgent({
      cwd, systemPrompt: verifyPrompt, userPrompt: "Verifica, corrige o que faltar, e escreve " + VERIFY_PATH + ".",
      mode: "build", orderId, appId, userId, model: CONFIG.WORKER_MODEL_VERIFY, idleMs: 600_000,
    });
    acc(rVer);
  }

  // --- relatório final honesto ---
  const verify = await readFile(path.join(cwd, VERIFY_PATH), "utf8").then((s) => parseJsonLoose<{ ok: boolean; resumo: string; por_fazer?: string[]; problemas?: string[] }>(s)).catch(() => null);
  const partes: string[] = [];
  partes.push(`Construí em ${planoMs.length} fases: ${planoMs.map((m) => m.titulo).join(" · ")}.`);
  if (verify?.resumo) partes.push(verify.resumo);
  if (verify?.por_fazer?.length) partes.push(`Para ficares 100% operacional, falta (do teu lado): ${verify.por_fazer.join("; ")}.`);
  if (verify?.problemas?.length) partes.push(`Ficou por resolver (honesto): ${verify.problemas.join("; ")}.`);
  const finalText = partes.join("\n\n");

  await runlog(orderId, "info", `deep-build fim · ${Math.round((Date.now() - t0) / 60000)}min · tokens=${tokens} · milestones=${planoMs.length}`);
  return { finalText, tokensUsed: tokens, sessionId, mcpToolsFaltantes: mcpFaltantes, toolsUsadas: tools, milestones: planoMs };
}
