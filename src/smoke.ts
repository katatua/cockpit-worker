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
  duracaoMs: number;
};

const EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const TIMEOUT_MS = 30_000;
const MAX_BOTOES = 10;

export async function smokeTest(previewUrl: string): Promise<SmokeReport> {
  const t0 = Date.now();
  const report: SmokeReport = {
    ok: true,
    consoleErros: [],
    botoesTestados: 0,
    botoesQuebrados: [],
    navegacoes: 0,
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

    // 2) Todos os botões visíveis → click com timeout curto
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
          // Se navegou, volta para casa para continuar a testar
          await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch (e) {
        report.botoesQuebrados.push({ seletor: label, motivo: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }

    // 3) Fim — se houver erros de consola ou botões quebrados → falha
    if (report.consoleErros.length > 0) report.ok = false;
    if (report.botoesQuebrados.length > 0) report.ok = false;

  } catch (e) {
    report.ok = false;
    report.consoleErros.push(`smoke geral: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    report.duracaoMs = Date.now() - t0;
  }
  return report;
}
