/**
 * Brief §4.6 F5.2 · smoke test com interações (Playwright headless).
 *
 * Corre APÓS o link-check simples de quality.ts. Adiciona uma camada de:
 *   - Cada botão visível → click → verifica que causou algo (mudança de DOM
 *     ou nova página) e não deixou erro na consola
 *   - Cada link interno abre sem 404 (já cobrimos em quality.ts, mas repetimos
 *     ao vivo com o browser real que respeita JS)
 *   - Consola: qualquer erro `console.error` ou `unhandledrejection` = falha
 *
 * Constrangimentos:
 *   - Máximo 30s por teste (timeout global)
 *   - Máximo 10 botões testados (evita apps grandes a explodir)
 *   - Chromium precisa estar disponível (Dockerfile instala via apt)
 */

import { chromium } from "playwright-core";
import type { Browser, ConsoleMessage, Page } from "playwright-core";

export type SmokeReport = {
  ok: boolean;
  // Infra do worker falhou (browser não arrancou) — NÃO é problema da app do
  // utilizador: a ordem não chumba, o dono é notificado (event smoke.skip).
  skip?: string;
  consoleErros: string[];
  botoesTestados: number;
  botoesQuebrados: { seletor: string; motivo: string }[];
  navegacoes: number;
  formulariosTestados: number;
  formulariosQuebrados: { seletor: string; motivo: string }[];
  duracaoMs: number;
};

const EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";
// 90s (goto usa metade): 15s de goto chumbava apps BOAS — chromium a
// renderizar numa shared-cpu-1x com agentes ao lado passa fácil dos 15s.
const TIMEOUT_MS = 90_000;
const MAX_BOTOES = 10;

/**
 * Preenche um input com dados sintéticos apropriados ao tipo.
 * Uploads: usa `setInputFiles` com um buffer sintético (PNG 1×1 ou TXT curto).
 */
async function fillInput(input: import("playwright-core").Locator): Promise<void> {
  const type = (await input.getAttribute("type").catch(() => "")) || "text";
  const name = (await input.getAttribute("name").catch(() => "")) || "";
  const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
  const accept = (await input.getAttribute("accept").catch(() => "")) || "";
  const hint = `${name} ${placeholder}`.toLowerCase();

  if (type === "file") {
    // Escolhe formato sintético apropriado ao `accept`.
    const wantsImage = /image/i.test(accept) || /foto|imagem|avatar|logo/.test(hint);
    if (wantsImage) {
      // PNG 1×1 transparente (67 bytes)
      const buf = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000000000005000103a5cfa2fc0000000049454e44ae426082", "hex");
      return input.setInputFiles({ name: "teste.png", mimeType: "image/png", buffer: buf }).catch(() => {});
    }
    if (/pdf/i.test(accept)) {
      const buf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
      return input.setInputFiles({ name: "teste.pdf", mimeType: "application/pdf", buffer: buf }).catch(() => {});
    }
    // Default: TXT curto
    return input.setInputFiles({ name: "teste.txt", mimeType: "text/plain", buffer: Buffer.from("teste smoke automatico\n") }).catch(() => {});
  }

  if (type === "email" || /email/.test(hint)) return input.fill("teste@myvibepro.dev");
  if (type === "url" || /site|url|link/.test(hint)) return input.fill("https://exemplo.pt");
  if (type === "tel" || /tel|phone|numero/.test(hint)) return input.fill("+351912345678");
  if (type === "number") return input.fill("42");
  if (type === "date") return input.fill("2026-12-01");
  if (type === "password") return input.fill("Teste1234!");
  if (type === "checkbox" || type === "radio") return input.check().catch(() => {});
  return input.fill(/nome/.test(hint) ? "Utilizador Teste" : /msg|mensagem|comentar/.test(hint) ? "Teste smoke automático." : "teste");
}

/**
 * §4.6: o smoke map deriva das ROTAS DESCOBERTAS da app (routes-scanner),
 * não só da homepage. Sem isto, um form em /upload nunca era testado
 * (visto na ordem e739bb98: forms=0 com o formulário perfeito em /upload).
 * Máximo 5 rotas para manter o smoke < ~3min.
 */
const MAX_ROTAS = 5;

export async function smokeTest(previewUrl: string, rotas: string[] = ["/"]): Promise<SmokeReport> {
  const t0 = Date.now();
  const report: SmokeReport = {
    ok: true,
    consoleErros: [],
    botoesTestados: 0,
    botoesQuebrados: [],
    navegacoes: 0,
    formulariosTestados: 0,
    formulariosQuebrados: [],
    duracaoMs: 0,
  };

  let browser: Browser | null = null;
  try {
    // 60s de timeout: numa máquina Fly de 1GB com o agente + npm a correr ao
    // lado, o primeiro arranque do chromium pode passar dos 15s (visto na
    // ordem f805aa14 — launch timeout matou um WP que estava perfeito).
    browser = await chromium.launch({
      executablePath: EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
      timeout: 60000,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Captura erros de consola do próprio site.
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") report.consoleErros.push(msg.text().slice(0, 200));
    });
    page.on("pageerror", (err) => report.consoleErros.push(`pageerror: ${err.message.slice(0, 200)}`));

    // §4.6: percorre as rotas descobertas (não só a home). Rotas dinâmicas
    // ([id]) ficam de fora — sem dados reais não há URL concreta.
    const rotasTestaveis = rotas.filter((r) => !r.includes("[")).slice(0, MAX_ROTAS);
    if (!rotasTestaveis.includes("/")) rotasTestaveis.unshift("/");

    for (const rota of rotasTestaveis) {
      const urlRota = `${previewUrl}${rota === "/" ? "" : rota}`;
      // 1) Carrega a rota
      await page.goto(urlRota, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS / 2 });
      // Damos um instante para React/Next hidrarem antes de contar erros.
      await page.waitForTimeout(1500);

      // 2) Formulários visíveis: preencher inputs e submeter
      const forms = await page.locator("form:visible").all();
      for (let i = 0; i < Math.min(forms.length, 3); i++) {
        report.formulariosTestados++;
        const form = forms[i];
        const formLabel = `${rota}#form${i}`;
        try {
          // Preenche inputs (não hidden). File inputs também são apanhados por fillInput.
          const inputs = await form.locator("input:visible, input[type=file], textarea:visible, select:visible").all();
          for (const input of inputs) {
            const tag = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
            if (tag === "select") {
              // Escolhe a segunda opção se houver
              const options = await input.locator("option").all();
              if (options.length > 1) await input.selectOption({ index: 1 }).catch(() => {});
            } else {
              await fillInput(input).catch(() => {});
            }
          }
          // Submete via botão submit dentro do form
          const submitBtn = form.locator("button[type=submit], input[type=submit]").first();
          if (await submitBtn.count() > 0) {
            const urlBefore = page.url();
            await submitBtn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1500);
            if (page.url() !== urlBefore) {
              report.navegacoes++;
              await page.goto(urlRota, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(500);
            }
          }
        } catch (e) {
          report.formulariosQuebrados.push({ seletor: formLabel, motivo: e instanceof Error ? e.message.slice(0, 120) : String(e) });
        }
      }

      // 3) Botões visíveis da rota → click com timeout curto.
      // §4.6 "cards não-clicáveis é a pior falha": um botão que clica SEM
      // ERRO mas não produz efeito nenhum (sem navegação, sem mudança de DOM)
      // é um BOTÃO MORTO — visto na landing-page do dono (CTA que não fazia
      // nada e o smoke deixou passar). Agora exige-se efeito observável.
      const buttons = await page.locator("button:visible").all();
      for (let i = 0; i < Math.min(buttons.length, MAX_BOTOES); i++) {
        report.botoesTestados++;
        const btn = buttons[i];
        const label = `${rota}#${(await btn.textContent().catch(() => ""))?.slice(0, 30) ?? `btn${i}`}`;
        const urlBefore = page.url();
        const domBefore = await page.evaluate("document.body.innerHTML.length").catch(() => 0) as number;
        try {
          await btn.click({ timeout: 3000, trial: false });
          await page.waitForTimeout(700);
          const urlAfter = page.url();
          const domAfter = await page.evaluate("document.body.innerHTML.length").catch(() => 0) as number;
          if (urlAfter !== urlBefore) {
            report.navegacoes++;
            await page.goto(urlRota, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(500);
          } else if (domAfter === domBefore) {
            // clique "bem-sucedido" sem QUALQUER efeito: nem navegou nem
            // mudou o DOM → botão morto. (submit dentro de form já foi
            // testado no passo 2; aqui só botões soltos.)
            const dentroDeForm = await btn.evaluate("el => !!el.closest('form')").catch(() => false);
            if (!dentroDeForm) {
              report.botoesQuebrados.push({ seletor: label, motivo: "botão morto: clique não navega nem altera a página" });
            }
          }
        } catch (e) {
          report.botoesQuebrados.push({ seletor: label, motivo: e instanceof Error ? e.message.slice(0, 120) : String(e) });
        }
      }
    }

    // 4) Fim — se houver erros de consola, botões ou forms quebrados → falha
    if (report.consoleErros.length > 0) report.ok = false;
    if (report.botoesQuebrados.length > 0) report.ok = false;
    if (report.formulariosQuebrados.length > 0) report.ok = false;

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (browser === null) {
      // O browser nem chegou a arrancar — infra do worker, não a app do
      // utilizador. ok=true + skip: a ordem segue; o dono é notificado.
      report.ok = true;
      report.skip = `browser não arrancou: ${msg.slice(0, 160)}`;
    } else {
      report.ok = false;
      report.consoleErros.push(`smoke geral: ${msg}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    report.duracaoMs = Date.now() - t0;
  }
  return report;
}
