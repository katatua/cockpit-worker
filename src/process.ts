/**
 * Processa UMA ordem end-to-end com LOOP de estratégias (Brief §5).
 *
 * Cada tentativa:
 *   1. Clona (ou reset se estratégia = "reescrever_do_zero")
 *   2. Corre o agente com userPrompt (+ guidance da estratégia atual)
 *   3. Verifica changes, commit, push, deploy, quality gate
 *   4. Se ok → preview_pronto; else → nextEstrategia com o erro real
 *
 * Sai do loop quando:
 *   - Sucesso (preview_pronto)
 *   - Estratégias esgotadas → falhou com erro_humano com alternativa
 *   - MAX_ITER (safety net absoluto contra runaway)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabase, tryLock, unlock, log, event, runlog, resetRunlogSeq, type OrderRow, type AppRow, type Plano } from "./db.js";
import { CONFIG } from "./config.js";
import { cleanWorktree, shallowClone, createBranch, hasChanges, commitAll, push, diffStat } from "./git.js";
import { runAgent } from "./agent.js";
import { waitForPreviewDeploy } from "./vercel.js";
import { checkQuality } from "./quality.js";
import { smokeTest } from "./smoke.js";
import { nextEstrategia, estrategiaGuidance, esgotadaHumana, type Estrategia } from "./loop-detector.js";
import { discoverRoutes } from "./routes-scanner.js";
import { scheduleNextRound } from "./campaign-sweep.js";
import { startHeartbeat } from "./heartbeat.js";

const MAX_ITER = 8; // safety net anti-runaway

const PASSOS = [
  "A preparar um espaço de trabalho seguro",
  "A perceber o pedido e a fazer as alterações",
  "A guardar as alterações",
  "A montar a pré-visualização",
] as const;

function makePlan(): Plano { return { passos: PASSOS.map((titulo, i) => ({ id: `p${i + 1}`, titulo, estado: "por_fazer" })) }; }
function step(plano: Plano, id: string, estado: Plano["passos"][number]["estado"]) {
  return { passos: plano.passos.map((p) => p.id === id ? { ...p, estado } : p) };
}

export async function processOrder(order: OrderRow): Promise<void> {
  const t0 = Date.now();
  console.log(`[${order.id.slice(0, 8)}] a processar (worker=${CONFIG.WORKER_ID})`);

  const { data: app } = await supabase.from("studio_apps").select("*").eq("id", order.app_id).single<AppRow>();
  if (!app) return failEarly(order, "app não existe");
  if (!app.github_repo) return fail(order, "sem github_repo — corre o Scaffolder primeiro");
  if (!app.vercel_project_id) return fail(order, "sem vercel_project_id — corre o Scaffolder primeiro");

  const gotLock = await tryLock(order.app_id, order.id, order.user_id);
  if (!gotLock) {
    await event(order.app_id, order.id, order.user_id, "worker.lock_ocupado", { worker: CONFIG.WORKER_ID });
    return;
  }

  resetRunlogSeq(order.id);
  let plano = makePlan();
  await supabase.from("studio_orders").update({ estado: "em_execucao", plano }).eq("id", order.id);
  await event(order.app_id, order.id, order.user_id, "worker.arranque", { worker: CONFIG.WORKER_ID, modo: order.modo });
  await runlog(order.id, "info", `worker=${CONFIG.WORKER_ID} arranque · modo=${order.modo}`);

  // Fatia B · heartbeat a cada 8s se houver silêncio > 6s no chat.
  const stopHeartbeat = startHeartbeat({ appId: order.app_id, orderId: order.id, userId: order.user_id });

  let lastError: string | null = null;
  let currentEstrategia: Estrategia = "padrao";
  let sessionId = order.session_id;
  let totalTokens = 0;

  try {
    for (let iter = 1; iter <= MAX_ITER; iter++) {
      await runlog(order.id, "info", `iteração ${iter}/${MAX_ITER} · estratégia=${currentEstrategia}`);

      // --- (1) Worktree (novo em cada iteração de reescrever_do_zero) ---
      const forceFresh = currentEstrategia === "reescrever_do_zero" || iter === 1;
      let worktree: string;
      let branch: string = `studio/${order.id.slice(0, 8)}`;
      if (forceFresh) {
        plano = step(plano, "p1", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
        if (iter === 1) await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A abrir o teu projeto…");
        else await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A começar do princípio com outra abordagem…");
        await runlog(order.id, "info", `clone ${app.github_repo}`);
        worktree = await cleanWorktree(order.id);
        await shallowClone(app.github_repo, worktree);
        await createBranch(worktree, branch);
        await runlog(order.id, "stdout", `branch criada: ${branch}`);
        plano = step(plano, "p1", "feito"); await supabase.from("studio_orders").update({ plano, branch }).eq("id", order.id);
      } else {
        // Iteração incremental: reutiliza worktree, agente vai por cima do commit anterior.
        worktree = path.join(CONFIG.WORKTREE_ROOT, order.id);
      }

      // --- (2) Contexto (só primeira vez) ---
      const [agentsMd, specMd] = await Promise.all([
        readFile(path.join(worktree, "AGENTS.md"), "utf8").catch(() => ""),
        readFile(path.join(worktree, "SPEC.md"), "utf8").catch(() => ""),
      ]);
      const systemPrompt = [
        "És o worker do Studio a modificar código da app do 0-coder.",
        "Segue AGENTS.md e SPEC.md do repo. Escreve código pequeno, focado, testado quando possível.",
        "Nunca inventes segredos. Nunca reportes sucesso sem editares mesmo.",
        agentsMd && `--- AGENTS.md ---\n${agentsMd}`,
        specMd && `--- SPEC.md ---\n${specMd}`,
      ].filter(Boolean).join("\n\n");

      // --- (3) Runs agent ---
      plano = step(plano, "p2", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);

      // Brief §4.5 · shortcut de revert: se o texto arranca com [REVERT commit_sha=...]
      // fazemos `git revert --no-edit <sha>` directamente (sem correr o agente,
      // determinístico). Nunca reescreve histórico — cria commit novo.
      const revertMatch = /^\[REVERT commit_sha=([0-9a-f]{7,40})\]/i.exec(order.texto);
      if (revertMatch) {
        const targetSha = revertMatch[1];
        await log(order.app_id, order.id, order.user_id, "agente", "atividade", `A voltar ao estado guardado…`);
        await runlog(order.id, "info", `revert target=${targetSha}`);
        const { runCmd } = await import("./git.js");
        try {
          await runCmd("git", ["-C", worktree, "revert", "--no-edit", targetSha]);
          await runlog(order.id, "edit", `git revert ${targetSha.slice(0, 7)} · ok`);
        } catch (e) {
          await runlog(order.id, "stderr", `revert falhou: ${e instanceof Error ? e.message : String(e)}`);
          throw new Error(`não consegui voltar a essa versão: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Salta o agente: já temos as alterações do revert; vai directo ao commit+push+quality.
        plano = step(plano, "p2", "feito");
        await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
        // Não incrementa tokens (revert é determinístico, sem LLM).
        // Continua para (4) commit+push
        // (usa um bloco separado — see abaixo)
      } else {
      const guidance = iter === 1 ? "" : estrategiaGuidance(currentEstrategia);
      const errCtx = lastError ? `\n\n[nota interna: iteração anterior falhou com "${lastError.slice(0, 200)}" — corrige]` : "";
      const userPrompt = guidance ? `${guidance}\n\n${order.texto}${errCtx}` : `${order.texto}${errCtx}`;
      if (iter === 1) await log(order.app_id, order.id, order.user_id, "agente", "pensamento", "A perceber o pedido…");
      else await log(order.app_id, order.id, order.user_id, "agente", "pensamento", `A tentar outra abordagem (${currentEstrategia.replace(/_/g, " ")})…`);
      await runlog(order.id, "tool", `agent.query iter=${iter}`);
      const runRes = await runAgent({
        cwd: worktree,
        systemPrompt,
        userPrompt,
        mode: order.modo,
        resumeSessionId: sessionId,
        orderId: order.id,
        appId: order.app_id,
        userId: order.user_id,
      });
      if (runRes.mcpToolsFaltantes.length > 0) {
        await event(order.app_id, order.id, order.user_id, "mcp.capacidade_em_falta", { tools: runRes.mcpToolsFaltantes });
      }
      totalTokens += runRes.tokensUsed;
      sessionId = runRes.sessionId;
      await runlog(order.id, "info", `agent tokens=${runRes.tokensUsed} · total=${totalTokens}`);
      plano = step(plano, "p2", "feito");
      await supabase.from("studio_orders").update({ plano, session_id: sessionId, tokens_usados: totalTokens }).eq("id", order.id);
      supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: runRes.tokensUsed }).then((r) => {
        if (r.error) console.warn(`[${order.id.slice(0, 8)}] quota update falhou: ${r.error.message}`);
      });
      if (runRes.finalText && iter === 1) await log(order.app_id, order.id, order.user_id, "agente", "texto", runRes.finalText);
      } // fim do else — só corre agente se NÃO for revert

      // --- (4) Commit + push ---
      plano = step(plano, "p3", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
      await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A verificar as alterações e a guardar…");
      const changed = await hasChanges(worktree);
      if (!changed) {
        lastError = "agente terminou sem alterar ficheiros";
        await runlog(order.id, "stderr", "sem alterações — próxima estratégia");
        const nx = await nextEstrategia(order.id, lastError);
        currentEstrategia = nx.estrategia;
        if (nx.esgotada) throw new Error(esgotadaHumana(lastError));
        continue;
      }
      const commitMsg = `studio: iter${iter} · ${order.texto.slice(0, 50)}${order.texto.length > 50 ? "…" : ""}\n\nordem: ${order.id} · estrategia: ${currentEstrategia}`;
      const sha = await commitAll(worktree, commitMsg);
      await runlog(order.id, "edit", `commit ${sha.slice(0, 7)}`);
      await push(worktree, branch);
      await runlog(order.id, "stdout", `push origin ${branch}`);
      const stat = await diffStat(worktree);
      plano = step(plano, "p3", "feito");
      await supabase.from("studio_orders").update({ plano, commit_sha: sha, diff_resumo: stat }).eq("id", order.id);
      await event(order.app_id, order.id, order.user_id, "worker.commit", { sha, branch, stat, iter });

      // --- (5) Vercel deploy ---
      plano = step(plano, "p4", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
      await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A esperar que a pré-visualização fique pronta…");
      await runlog(order.id, "deploy", `poll vercel · branch=${branch}`);
      const deploy = await waitForPreviewDeploy(app.vercel_project_id, branch);
      await runlog(order.id, "deploy", `READY · ${deploy.url}`);

      // --- (6a) Quality gate HTTP link check ---
      await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A verificar se tudo funciona…");
      await runlog(order.id, "info", `quality gate iter${iter} · ${deploy.url}`);
      const quality = await checkQuality(deploy.url);
      await runlog(order.id, "info", `quality: ${quality.checked} URLs, ${quality.falhas.length} problemas`);
      if (!quality.ok) {
        for (const f of quality.falhas.slice(0, 10)) await runlog(order.id, "stderr", `broken: ${f.url} · ${f.motivo}`);
        lastError = `${quality.falhas.length} URLs partidos: ${quality.falhas.slice(0, 3).map((f) => `${f.url} (${f.status})`).join(", ")}`;
        const resumo = quality.falhas.length === 1
          ? "Um link não está a funcionar. Vou tentar corrigir."
          : `${quality.falhas.length} coisas não funcionam. Vou tentar corrigir.`;
        await log(order.app_id, order.id, order.user_id, "agente", "erro_humano", resumo);
        const nx = await nextEstrategia(order.id, lastError);
        currentEstrategia = nx.estrategia;
        if (nx.esgotada) throw new Error(esgotadaHumana(lastError));
        continue;
      }

      // --- (6b) Smoke Playwright — clique em botões, verifica consola ---
      await runlog(order.id, "info", `smoke playwright · ${deploy.url}`);
      const smoke = await smokeTest(deploy.url).catch((e) => {
        // Se o Chromium não iniciar (imagem sem playwright, dev local), regista
        // e continua — não bloqueia MVP se o browser em falta.
        console.warn(`[${order.id.slice(0, 8)}] smoke skip:`, e.message);
        return null;
      });
      if (smoke) {
        await runlog(order.id, "info", `smoke: ${smoke.botoesTestados} botões, ${smoke.formulariosTestados} forms, ${smoke.consoleErros.length} erros consola, ${smoke.navegacoes} navegações (${smoke.duracaoMs}ms)`);
        for (const err of smoke.consoleErros.slice(0, 5)) await runlog(order.id, "stderr", `console: ${err}`);
        for (const b of smoke.botoesQuebrados.slice(0, 5)) await runlog(order.id, "stderr", `botão quebrado: ${b.seletor} · ${b.motivo}`);
        for (const f of smoke.formulariosQuebrados.slice(0, 5)) await runlog(order.id, "stderr", `form quebrado: ${f.seletor} · ${f.motivo}`);
        if (!smoke.ok) {
          const partes = [];
          if (smoke.botoesQuebrados.length > 0) partes.push(`${smoke.botoesQuebrados.length} botões`);
          if (smoke.formulariosQuebrados.length > 0) partes.push(`${smoke.formulariosQuebrados.length} forms`);
          if (smoke.consoleErros.length > 0) partes.push(`${smoke.consoleErros.length} erros consola`);
          lastError = `smoke falhou: ${partes.join(" + ")}`;
          const resumo = partes.length > 0
            ? `${partes.join(" + ")} não funcionam bem. Vou tentar corrigir.`
            : `A app está a dar erros. Vou tentar corrigir.`;
          await log(order.app_id, order.id, order.user_id, "agente", "erro_humano", resumo);
          const nx = await nextEstrategia(order.id, lastError);
          currentEstrategia = nx.estrategia;
          if (nx.esgotada) throw new Error(esgotadaHumana(lastError));
          continue;
        }
      }

      // --- (7) Sucesso ---
      plano = step(plano, "p4", "feito");

      // Brief §4.1: descobre rotas do repo e escreve em studio_apps.rotas
      // para o dropdown do preview toolbar ficar dinâmico.
      const rotas = await discoverRoutes(worktree).catch(() => ["/"]);
      await supabase.from("studio_apps").update({ rotas }).eq("id", app.id);
      await runlog(order.id, "info", `rotas descobertas: ${rotas.join(", ")}`);

      await supabase.from("studio_orders").update({
        plano, preview_url: deploy.url, preview_deploy_id: deploy.deployId, estado: "preview_pronto",
      }).eq("id", order.id);
      await log(order.app_id, order.id, order.user_id, "agente", "texto", `✓ Pré-visualização pronta.`);
      await event(order.app_id, order.id, order.user_id, "worker.preview_pronto", {
        url: deploy.url, ms: Date.now() - t0, qualityChecked: quality.checked, iter, totalTokens,
      });
      console.log(`[${order.id.slice(0, 8)}] preview_pronto em ${Date.now() - t0}ms · iter=${iter} · ${deploy.url}`);

      // --- (8) Encadeamento de campanha (Brief §4.9) ---
      // Se esta ordem faz parte duma campanha, marca o WP correspondente como
      // 'feito' e cria a próxima ordem para o WP seguinte (se houver).
      const { data: orderExt } = await supabase.from("studio_orders").select("campaign_id, tipo").eq("id", order.id).maybeSingle();
      const campaignId = (orderExt as { campaign_id?: string } | null)?.campaign_id;
      if (campaignId) {
        // Marca o WP atual como feito (heurística: o WP com ordem menor não_feito)
        const { data: wps } = await supabase
          .from("studio_workpackages")
          .select("id, ordem, titulo, razao, estado")
          .eq("campaign_id", campaignId)
          .order("ordem", { ascending: true });
        const naoFeitos = (wps ?? []).filter((w) => w.estado === "nao_feito");
        if (naoFeitos.length > 0) {
          const atual = naoFeitos[0];
          await supabase.from("studio_workpackages").update({ estado: "feito" }).eq("id", atual.id);
          const seguinte = naoFeitos[1];
          if (seguinte) {
            // Cria próxima ordem
            await supabase.from("studio_orders").insert({
              app_id: order.app_id, campaign_id: campaignId, tipo: "campanha", user_id: order.user_id,
              texto: `[Campanha WP ${seguinte.ordem}] ${seguinte.titulo}: ${seguinte.razao ?? ""}`,
              modo: "build", estado: "em_fila",
            });
            await event(order.app_id, null, order.user_id, "campanha.wp_seguinte", { campaign_id: campaignId, wp_id: seguinte.id });
          } else {
            // Todos os WPs feitos → sweep da spec para ver se restam gaps.
            await supabase.from("studio_campaigns").update({ estado: "a_varrer" }).eq("id", campaignId);
            await event(order.app_id, null, order.user_id, "campanha.a_varrer", { campaign_id: campaignId });
            try {
              const sweep = await scheduleNextRound(campaignId, order.app_id, order.user_id, worktree, CONFIG.ANTHROPIC_API_KEY);
              if (sweep.campaign_id) {
                await event(order.app_id, null, order.user_id, "campanha.nova_ronda", {
                  campaign_id_antiga: campaignId, campaign_id_nova: sweep.campaign_id,
                  items: sweep.items, tokensUsedSweep: sweep.tokensUsed,
                });
                // A campanha antiga fica marcada como concluida (a nova toma o testemunho)
                await supabase.from("studio_campaigns").update({ estado: "concluida" }).eq("id", campaignId);
              } else {
                await supabase.from("studio_campaigns").update({ estado: "concluida" }).eq("id", campaignId);
                await event(order.app_id, null, order.user_id, "campanha.concluida", {
                  campaign_id: campaignId, items: sweep.items, tokensUsedSweep: sweep.tokensUsed,
                });
              }
            } catch (e) {
              await supabase.from("studio_campaigns").update({ estado: "concluida" }).eq("id", campaignId);
              await event(order.app_id, null, order.user_id, "campanha.sweep_erro", { campaign_id: campaignId, motivo: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      }
      return;
    }
    // Passou do MAX_ITER — safety net.
    throw new Error(esgotadaHumana("limite absoluto de iterações"));
  } catch (e) {
    await fail(order, e instanceof Error ? e.message : String(e));
  } finally {
    stopHeartbeat();
    await unlock(order.app_id);
    await event(order.app_id, order.id, order.user_id, "worker.lock_libertado", {});
  }
}

async function fail(order: OrderRow, motivo: string) {
  console.error(`[${order.id.slice(0, 8)}] falhou: ${motivo}`);
  await supabase.from("studio_orders").update({ estado: "falhou", erro: motivo }).eq("id", order.id);
  // Traduz mensagens técnicas para humano quando dá para reconhecer.
  const humano = motivo.startsWith("Tentei várias abordagens") ? motivo
    : /aborted by user|demorou muito/i.test(motivo) ? "A demorar demasiado — parei para não gastar mais. Tenta reformular ou dividir em pedaços menores."
    : /nada para publicar/i.test(motivo) ? "Não consegui perceber que alterações fazer. Reformula o pedido de forma mais concreta."
    : null;
  await log(order.app_id, order.id, order.user_id, "sistema", humano ? "erro_humano" : "erro", humano ?? motivo);
  await runlog(order.id, "stderr", `falhou: ${motivo}`);
  await event(order.app_id, order.id, order.user_id, "worker.falhou", { motivo });
}

async function failEarly(order: OrderRow, motivo: string) {
  await supabase.from("studio_orders").update({ estado: "falhou", erro: motivo }).eq("id", order.id);
}
