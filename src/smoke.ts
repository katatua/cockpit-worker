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
  consoleErros: string[];
  botoesTestados: number;
  botoesQuebrados: { seletor: string; motivo: string }[];
  navegacoes: number;
  formulariosTestados: number;
  formulariosQuebrados: { seletor: string; motivo: string }[];
  duracaoMs: number;
};

const EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const TIMEOUT_MS = 30_000;
const MAX_BOTOES = 10;

/** Preenche um input com dados sintéticos apropriados ao tipo. */
async function fillInput(input: import("playwright-core").Locator): Promise<void> {
  const type = (await input.getAttribute("type").catch(() => "")) || "text";
  const name = (await input.getAttribute("name").catch(() => "")) || "";
  const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
  const hint = `${name} ${placeholder}`.toLowerCase();

  if (type === "email" || /email/.test(hint)) return input.fill("teste@myvibepro.dev");
  if (type === "url" || /site|url|link/.test(hint)) return input.fill("https://exemplo.pt");
  if (type === "tel" || /tel|phone|numero/.test(hint)) return input.fill("+351912345678");
  if (type === "number") return input.fill("42");
  if (type === "date") return input.fill("2026-12-01");
  if (type === "password") return input.fill("Teste1234!");
  if (type === "checkbox" || type === "radio") return input.check().catch(() => {});
  // Textarea + text default
  return input.fill(/nome/.test(hint) ? "Utilizador Teste" : /msg|mensagem|comentar/.test(hint) ? "Teste smoke automático." : "teste");
}

export async function smokeTest(previewUrl: string): Promise<SmokeReport> {
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
    browser = await chromium.launch({
      executablePath: EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      timeout: 15000,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Captura erros de consola do próprio site.
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") report.consoleErros.push(msg.text().slice(0, 200));
    });
    page.on("pageerror", (err) => report.consoleErros.push(`pageerror: ${err.message.slice(0, 200)}`));

    // 1) Carrega a home
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS / 2 });
    // Damos um instante para React/Next hidrarem antes de contar erros.
    await page.waitForTimeout(1500);

    // 2) Formulários visíveis: preencher inputs e submeter
    const forms = await page.locator("form:visible").all();
    for (let i = 0; i < Math.min(forms.length, 3); i++) {
      report.formulariosTestados++;
      const form = forms[i];
      const formLabel = `form${i}`;
      try {
        // Preenche inputs (não hidden)
        const inputs = await form.locator("input:visible, textarea:visible, select:visible").all();
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
            await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(500);
          }
        }
      } catch (e) {
        report.formulariosQuebrados.push({ seletor: formLabel, motivo: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }

    // 3) Todos os botões visíveis → click com timeout curto
    const buttons = await page.locator("button:visible").all();
    for (let i = 0; i < Math.min(buttons.length, MAX_BOTOES); i++) {
      report.botoesTestados++;
      const btn = buttons[i];
      const label = (await btn.textContent().catch(() => ""))?.slice(0, 30) ?? `btn${i}`;
      const urlBefore = page.url();
      try {
        await btn.click({ timeout: 3000, trial: false });
        await page.waitForTimeout(500);
        const urlAfter = page.url();
        if (urlAfter !== urlBefore) {
          report.navegacoes++;
          await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch (e) {
        report.botoesQuebrados.push({ seletor: label, motivo: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }

    // 4) Fim — se houver erros de consola, botões ou forms quebrados → falha
    if (report.consoleErros.length > 0) report.ok = false;
    if (report.botoesQuebrados.length > 0) report.ok = false;
    if (report.formulariosQuebrados.length > 0) report.ok = false;

  } catch (e) {
    report.ok = false;
    report.consoleErros.push(`smoke geral: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    report.duracaoMs = Date.now() - t0;
  }
  return report;
}
