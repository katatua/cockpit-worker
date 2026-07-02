/**
 * Processa UMA ordem end-to-end. Cada passo é honesto: se falha, marca
 * ordem 'falhou' com o erro real e nunca avança.
 *
 * Fluxo:
 *   1. Adquirir lock; carregar app + ordem.
 *   2. Se app não tem github_repo/vercel_project_id → falhou (não há onde escrever).
 *   3. Clone shallow → cria branch studio/<orderId>.
 *   4. Lê AGENTS.md/SPEC.md do repo (se existirem) para o system prompt.
 *   5. Corre runAgent() com o texto da ordem.
 *   6. Se não houver alterações → falhou honesta (agente não fez nada).
 *   7. Commit + push da branch.
 *   8. Espera Vercel construir o deploy de preview → READY.
 *   9. Actualiza ordem: preview_url REAL, commit_sha, branch, tokens, estado=preview_pronto.
 *
 *   Em qualquer passo — falhou + erro real + libertar lock.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabase, tryLock, unlock, log, event, runlog, resetRunlogSeq, type OrderRow, type AppRow, type Plano } from "./db.js";
import { CONFIG } from "./config.js";
import { cleanWorktree, shallowClone, createBranch, hasChanges, commitAll, push, diffStat } from "./git.js";
import { runAgent } from "./agent.js";
import { waitForPreviewDeploy } from "./vercel.js";
import { checkQuality } from "./quality.js";

// Studio Fatia 4: rótulos humanos no plano (o tecnês vive no terminal).
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

  // Load app.
  const { data: app } = await supabase.from("studio_apps").select("*").eq("id", order.app_id).single<AppRow>();
  if (!app) return failEarly(order, "app não existe");
  if (!app.github_repo) return fail(order, "sem github_repo — corre o Scaffolder primeiro");
  if (!app.vercel_project_id) return fail(order, "sem vercel_project_id — corre o Scaffolder primeiro");

  // Acquire lock atomicamente.
  const gotLock = await tryLock(order.app_id, order.id, order.user_id);
  if (!gotLock) {
    await event(order.app_id, order.id, order.user_id, "worker.lock_ocupado", { worker: CONFIG.WORKER_ID });
    return; // outra ordem está a correr; volta ao poll
  }

  resetRunlogSeq(order.id);
  let plano = makePlan();
  await supabase.from("studio_orders").update({ estado: "em_execucao", plano }).eq("id", order.id);
  await event(order.app_id, order.id, order.user_id, "worker.arranque", { worker: CONFIG.WORKER_ID, modo: order.modo });
  await runlog(order.id, "info", `worker=${CONFIG.WORKER_ID} arranque · modo=${order.modo}`);

  try {
    // (1) Worktree.
    plano = step(plano, "p1", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
    await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A abrir o teu projeto…");
    await runlog(order.id, "info", `clone ${app.github_repo} → ${order.id.slice(0, 8)}`);
    const worktree = await cleanWorktree(order.id);
    await shallowClone(app.github_repo, worktree);
    const branch = `studio/${order.id.slice(0, 8)}`;
    await createBranch(worktree, branch);
    await runlog(order.id, "stdout", `branch criada: ${branch}`);
    plano = step(plano, "p1", "feito"); await supabase.from("studio_orders").update({ plano, branch }).eq("id", order.id);

    // (2) Contexto do system prompt: AGENTS.md + SPEC.md (se existirem).
    const [agentsMd, specMd] = await Promise.all([
      readFile(path.join(worktree, "AGENTS.md"), "utf8").catch(() => ""),
      readFile(path.join(worktree, "SPEC.md"), "utf8").catch(() => ""),
    ]);
    await runlog(order.id, "info", `contexto: AGENTS.md=${agentsMd.length}b · SPEC.md=${specMd.length}b`);
    const systemPrompt = [
      "És o worker do Studio a modificar código da app do 0-coder.",
      "Segue AGENTS.md e SPEC.md do repo. Escreve código pequeno, focado, testado quando possível.",
      "Nunca inventes segredos. Nunca reportes sucesso sem editares mesmo. Se não há alteração possível, diz claramente.",
      agentsMd && `--- AGENTS.md ---\n${agentsMd}`,
      specMd && `--- SPEC.md ---\n${specMd}`,
    ].filter(Boolean).join("\n\n");

    plano = step(plano, "p2", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
    await log(order.app_id, order.id, order.user_id, "agente", "pensamento", "A perceber o pedido…");
    await runlog(order.id, "tool", `agent.query · mode=${order.modo}`);
    const runRes = await runAgent({
      cwd: worktree,
      systemPrompt,
      userPrompt: order.texto,
      mode: order.modo,
      resumeSessionId: order.session_id,
    });
    await runlog(order.id, "info", `agent terminou · tokens=${runRes.tokensUsed} · session=${runRes.sessionId?.slice(0, 8) ?? "?"}`);
    plano = step(plano, "p2", "feito");
    await supabase.from("studio_orders").update({ plano, session_id: runRes.sessionId, tokens_usados: runRes.tokensUsed }).eq("id", order.id);
    // SaaS-0 F2: também contabiliza na quota mensal do user (RPC atómica).
    supabase.rpc("increment_user_tokens", { p_user_id: order.user_id, p_amount: runRes.tokensUsed }).then((r) => {
      if (r.error) console.warn(`[${order.id.slice(0, 8)}] quota update falhou: ${r.error.message}`);
    });
    if (runRes.finalText) await log(order.app_id, order.id, order.user_id, "agente", "texto", runRes.finalText);

    // (3) Commit + push (só se houver alterações).
    plano = step(plano, "p3", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
    await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A verificar as alterações e a guardar…");
    const changed = await hasChanges(worktree);
    if (!changed) { await runlog(order.id, "stderr", "nenhuma alteração detectada"); throw new Error("agente terminou sem alterar ficheiros — nada para publicar. Reformula o pedido."); }
    const commitMsg = `studio: ${order.texto.slice(0, 60)}${order.texto.length > 60 ? "…" : ""}\n\nordem: ${order.id}`;
    const sha = await commitAll(worktree, commitMsg);
    await runlog(order.id, "edit", `commit ${sha.slice(0, 7)} · ${commitMsg.split("\n")[0]}`);
    await push(worktree, branch);
    await runlog(order.id, "stdout", `push origin ${branch} · ok`);
    const stat = await diffStat(worktree);
    await runlog(order.id, "stdout", stat.replace(/\n/g, " · "));
    plano = step(plano, "p3", "feito");
    await supabase.from("studio_orders").update({ plano, commit_sha: sha, diff_resumo: stat }).eq("id", order.id);
    await event(order.app_id, order.id, order.user_id, "worker.commit", { sha, branch, stat });

    // (4) Aguarda deploy Vercel READY.
    plano = step(plano, "p4", "em_execucao"); await supabase.from("studio_orders").update({ plano }).eq("id", order.id);
    await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A esperar que a pré-visualização fique pronta…");
    await runlog(order.id, "deploy", `poll vercel · project=${app.vercel_project_id} · branch=${branch}`);
    const deploy = await waitForPreviewDeploy(app.vercel_project_id, branch);
    await runlog(order.id, "deploy", `READY · ${deploy.url}`);

    // Brief §4.6 · quality gate prova-de-vida.
    // Antes de marcar preview_pronto, verifica que a app não está partida.
    await log(order.app_id, order.id, order.user_id, "agente", "atividade", "A verificar se tudo funciona…");
    await runlog(order.id, "info", `quality gate · ${deploy.url}`);
    const quality = await checkQuality(deploy.url);
    await runlog(order.id, "info", `quality gate: ${quality.checked} URLs, ${quality.falhas.length} problemas`);
    if (!quality.ok) {
      // Falha honesta: escreve o resultado no runlog + falha ordem com motivo humano.
      // A UI mostra `erro_humano`. O detetor de loop (F16) vai decidir estratégia
      // alternativa nas próximas iterações.
      for (const f of quality.falhas.slice(0, 10)) {
        await runlog(order.id, "stderr", `broken: ${f.url} · ${f.motivo}`);
      }
      const resumo = quality.falhas.length === 1
        ? "Um link não está a funcionar. Vou tentar corrigir."
        : `${quality.falhas.length} coisas não estão a funcionar. Vou tentar corrigir.`;
      await log(order.app_id, order.id, order.user_id, "agente", "erro_humano", resumo);
      await event(order.app_id, order.id, order.user_id, "worker.quality_falhou", { checked: quality.checked, falhas: quality.falhas });
      throw new Error(`quality gate falhou: ${quality.falhas.length} problemas em ${quality.checked} URLs`);
    }

    plano = step(plano, "p4", "feito");
    await supabase.from("studio_orders").update({
      plano, preview_url: deploy.url, preview_deploy_id: deploy.deployId, estado: "preview_pronto",
    }).eq("id", order.id);
    await log(order.app_id, order.id, order.user_id, "agente", "texto", `✓ Pré-visualização pronta.`);
    await event(order.app_id, order.id, order.user_id, "worker.preview_pronto", { url: deploy.url, ms: Date.now() - t0, qualityChecked: quality.checked });

    console.log(`[${order.id.slice(0, 8)}] preview_pronto em ${Date.now() - t0}ms · ${deploy.url}`);
  } catch (e) {
    await fail(order, e instanceof Error ? e.message : String(e));
  } finally {
    await unlock(order.app_id);
    await event(order.app_id, order.id, order.user_id, "worker.lock_libertado", {});
  }
}

async function fail(order: OrderRow, motivo: string) {
  console.error(`[${order.id.slice(0, 8)}] falhou: ${motivo}`);
  await supabase.from("studio_orders").update({ estado: "falhou", erro: motivo }).eq("id", order.id);
  await log(order.app_id, order.id, order.user_id, "sistema", "erro", motivo);
  await runlog(order.id, "stderr", `falhou: ${motivo}`);
  await event(order.app_id, order.id, order.user_id, "worker.falhou", { motivo });
}

async function failEarly(order: OrderRow, motivo: string) {
  await supabase.from("studio_orders").update({ estado: "falhou", erro: motivo }).eq("id", order.id);
}
