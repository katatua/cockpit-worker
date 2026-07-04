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
  // C6.4: controlo com handler mas sem efeito observável NEM estado acessível
  // (aria-pressed/aria-selected/data-state). Falha o gate com mensagem
  // DISTINTA de "morto" — o fix é acrescentar o atributo, não mexer no handler.
  naoTestaveis: { seletor: string; motivo: string }[];
  // C6.5: o controlo funciona (handler ligado + mutações observadas) mas a
  // asserção tipada não reconheceu o efeito → suspeita do ORÁCULO, não do
  // código. NUNCA chumba a ordem (política warn) nem alimenta `tentativas`.
  oracleSuspects: { seletor: string; motivo: string }[];
  // C6.2: nº de itens semeados pela via de criação da app antes de asserir
  // filtros/seletores (filtro contra coleção vazia é no-op — proibido).
  sementes: number;
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

// ---------------------------------------------------------------------------
// C6 · sondas no browser (strings — correm no contexto da página)
// ---------------------------------------------------------------------------

/** Hash do DOM (deteta QUALQUER mudança real; length era cego a trocas de classe). */
const DOM_HASH = "(()=>{let h=0;const s=document.body.innerHTML;for(let i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0}return h})()";

/** C6.5(2): contador global de mutações — instala 1 observer, reset por clique. */
const MUT_INSTALL = "(()=>{if(!window.__smokeObs){window.__smokeMuts=0;window.__smokeObs=new MutationObserver(m=>{window.__smokeMuts+=m.length});window.__smokeObs.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});}window.__smokeMuts=0;return true})()";

/**
 * C6.1: estado próprio legível por máquina (toggle/seletor/tab/radio).
 * NOTA: closures reais, não strings — locator.evaluate("el => …") falha
 * silenciosamente nesta versão do playwright-core (foi a causa de "Todas"
 * cair em suspect e "Ordenar" em morto no primeiro verify C6).
 */
// Tipo estrutural mínimo (o tsconfig do worker não carrega a lib DOM).
type ElLike = {
  getAttribute(n: string): string | null;
  closest(s: string): unknown;
  parentElement: ElLike | null;
  onclick?: unknown;
  __smokeClickHandler?: boolean;
};

const ownState = (el: ElLike) => JSON.stringify({
  p: el.getAttribute("aria-pressed"), s: el.getAttribute("aria-selected"),
  d: el.getAttribute("data-state"), r: el.getAttribute("role"),
  c: el.getAttribute("aria-checked"),
});

/**
 * C6.5(1): handler ligado? Três fontes, por ordem de precisão:
 * onclick direto · props React (__reactProps$) · addEventListener("click")
 * registado pelo init-script (apps vanilla — invisível às outras duas).
 */
const temHandler = (el: ElLike) => {
  let n: ElLike | null = el;
  while (n) {
    if (n.onclick || n.__smokeClickHandler) return true;
    for (const k in n) {
      if (k.startsWith("__reactProps$")) {
        const p = (n as unknown as Record<string, { onClick?: unknown; onPointerDown?: unknown; onMouseDown?: unknown } | undefined>)[k];
        if (p && (p.onClick || p.onPointerDown || p.onMouseDown)) return true;
      }
    }
    n = n.parentElement;
  }
  return false;
};

/** Init-script: marca elementos que recebem addEventListener("click"). */
const TRACK_LISTENERS = `(() => {
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === "click" || type === "pointerdown" || type === "mousedown") {
      try { this.__smokeClickHandler = true; } catch {}
    }
    return orig.call(this, type, ...rest);
  };
})()`;

/**
 * C6.2 · Sementeira determinística: numa vista com via de criação (form com
 * input de texto), cria 2 itens representativos ANTES de asserir filtros e
 * marca o 2º como concluído (cobre os estados que os filtros particionam).
 * Melhor esforço — nunca lança; devolve nº de itens criados.
 */
async function semearColecao(page: Page): Promise<number> {
  let criados = 0;
  try {
    // Seletores CANÓNICOS primeiro (o scaffold/prompt pede data-testid
    // estáveis: new-item-input / new-item-submit); heurística como fallback.
    const canonico = page.locator('[data-testid="new-item-input"]').first();
    const usaCanonico = (await canonico.count()) > 0;
    const form = page.locator("form:visible").first();
    if (!usaCanonico && (await form.count()) === 0) return 0;
    const input = usaCanonico ? canonico
      : form.locator('input[type="text"]:visible, input:not([type]):visible').first();
    if ((await input.count()) === 0) return 0;
    const submit = usaCanonico
      ? page.locator('[data-testid="new-item-submit"], button[type="submit"]').first()
      : form.locator('button[type="submit"], input[type="submit"], button').first();
    if ((await submit.count()) === 0) return 0;
    for (const txt of ["Tarefa semeada ativa", "Tarefa semeada concluída"]) {
      await input.fill(txt);
      // Enter cobre forms com onSubmit; o clique cobre botões type=button.
      const podeClicar = !(await submit.isDisabled().catch(() => true));
      if (podeClicar) await submit.click({ timeout: 2000 }).catch(() => {});
      else await input.press("Enter").catch(() => {});
      await page.waitForTimeout(400);
      criados++;
    }
    // Alterna o estado do último item criado (checkbox/toggle dentro da coleção).
    const chk = page.locator("li input[type=checkbox]:visible, [role=listitem] input[type=checkbox]:visible, li [role=checkbox]:visible").last();
    if ((await chk.count()) > 0) await chk.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  } catch { /* sementeira é melhor-esforço */ }
  return criados;
}

export async function smokeTest(previewUrl: string, rotas: string[] = ["/"]): Promise<SmokeReport> {
  const t0 = Date.now();
  const report: SmokeReport = {
    ok: true,
    consoleErros: [],
    botoesTestados: 0,
    botoesQuebrados: [],
    naoTestaveis: [],
    oracleSuspects: [],
    sementes: 0,
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
    await context.addInitScript(TRACK_LISTENERS); // C6.5(1): deteta handlers vanilla
    const page = await context.newPage();

    // Captura erros de consola do próprio site — MAS ignora ruído benigno
    // (favicon/manifest/ícones em falta, recursos externos). Um favicon 404 NÃO
    // é uma app partida; fazer a app chumbar por isso prendia o agente num loop.
    const CONSOLE_BENIGNO = /favicon|apple-touch-icon|manifest\.(json|webmanifest)|icon-\d+|robots\.txt|\/sw\.js/i;
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const txt = msg.text();
      if (CONSOLE_BENIGNO.test(txt)) return;
      report.consoleErros.push(txt.slice(0, 200));
    });
    page.on("pageerror", (err) => report.consoleErros.push(`pageerror: ${err.message.slice(0, 200)}`));
    // C6.10: respostas HTTP >=400 e requests falhados também contam (um fetch
    // interno a 500 é uma app partida mesmo com a consola limpa) — com o mesmo
    // filtro de ruído benigno do favicon/manifest.
    page.on("response", (res) => {
      if (res.status() >= 400 && !CONSOLE_BENIGNO.test(res.url())) {
        report.consoleErros.push(`http ${res.status()}: ${res.url().slice(0, 160)}`);
      }
    });
    page.on("requestfailed", (req) => {
      if (!CONSOLE_BENIGNO.test(req.url())) {
        report.consoleErros.push(`requestfailed: ${req.url().slice(0, 160)}`);
      }
    });

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

      // C6.2) Sementeira ANTES dos botões: filtros/seletores só são
      // asseríveis contra uma coleção não-vazia (filtro em lista vazia é
      // no-op — 3 iterações queimadas na ordem aca7d5da por isto).
      report.sementes += await semearColecao(page);

      // 3) Controlos interativos da rota → click com asserção POR TIPO DE
      // EFEITO (C6.1/C6.3). Inventário alargado: não só <button> — também
      // divs/spans com role de controlo (comum em UI React "de mão"). Um
      // controlo só é "morto" quando: não navega, não muda o DOM (hash),
      // não faz scroll, não vira o próprio estado E não tem handler.
      const buttons = await page.locator('button:visible, [role="button"]:visible, [role="tab"]:visible, [role="radio"]:visible, [role="switch"]:visible').all();
      for (let i = 0; i < Math.min(buttons.length, MAX_BOTOES); i++) {
        const btn = buttons[i];
        // C6.1 `submit-disabled`: disabled é comportamento correto, não teste.
        if (await btn.isDisabled().catch(() => false)) continue;
        report.botoesTestados++;
        const label = `${rota}#${(await btn.textContent().catch(() => ""))?.slice(0, 30) ?? `btn${i}`}`;
        const urlBefore = page.url();
        const domBefore = await page.evaluate(DOM_HASH).catch(() => 0) as number;
        const scrollBefore = await page.evaluate("window.scrollY").catch(() => 0) as number;
        const stateBefore = await btn.evaluate(ownState).catch(() => "{}");
        await page.evaluate(MUT_INSTALL).catch(() => {});
        try {
          await btn.click({ timeout: 3000, trial: false });
          await page.waitForTimeout(700);
          const urlAfter = page.url();
          const domAfter = await page.evaluate(DOM_HASH).catch(() => 0) as number;
          const scrollAfter = await page.evaluate("window.scrollY").catch(() => 0) as number;
          const fezScroll = Math.abs(scrollAfter - scrollBefore) >= 4; // scroll-to-secção é efeito VÁLIDO

          if (urlAfter !== urlBefore) {
            report.navegacoes++;
            await page.goto(urlRota, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(500);
            continue;
          }
          if (domAfter !== domBefore || fezScroll) continue; // efeito observável → OK

          // Sem efeito aparente. C6.3: um toggle/radio JÁ ATIVO clicado de novo
          // é um no-op legítimo (radio semantics) — não é botão morto.
          const st = JSON.parse(stateBefore || "{}") as Record<string, string | null>;
          const jaAtivo = st.p === "true" || st.s === "true" || st.c === "true" || st.d === "active" || st.d === "on" || st.d === "checked";
          if (jaAtivo) continue;
          const temEstadoA11y = st.p !== null || st.s !== null || st.c !== null || st.d !== null || st.r === "tab" || st.r === "radio";

          // C6.5: sonda de falsificabilidade — handler ligado? correu?
          const handler = await btn.evaluate(temHandler).catch(() => false);
          const mutacoes = await page.evaluate("window.__smokeMuts ?? 0").catch(() => 0) as number;
          const dentroDeForm = await btn.evaluate((el) => !!el.closest("form")).catch(() => false);
          if (dentroDeForm) continue; // submits são testados no passo 2

          // Veredicto (C6.5): MUTAÇÕES são a evidência primária de que o
          // handler correu — cobrem efeitos fora do body.innerHTML (title,
          // <head>, atributos do <html>) que o hash não vê.
          if (mutacoes > 0) {
            // Algo correu de facto, mas a asserção não reconheceu o efeito →
            // suspeito é o ORÁCULO, não o código. Nunca alimenta `tentativas`.
            report.oracleSuspects.push({ seletor: label, motivo: `houve ${mutacoes} mutações ao clicar mas o efeito não foi reconhecido pela asserção` });
          } else if (handler && !temEstadoA11y) {
            // C6.4 lei da app: controlo interativo sem estado legível por máquina.
            report.naoTestaveis.push({ seletor: label, motivo: "não-testável: tem handler mas nenhum efeito observável nem estado acessível — adiciona aria-pressed/aria-selected (ou data-state) ao controlo" });
          } else if (handler && temEstadoA11y) {
            // Tem estado a11y, não estava ativo, o handler correu… e o estado
            // não virou → defeito real do controlo.
            report.botoesQuebrados.push({ seletor: label, motivo: "botão de estado não vira o próprio aria/data-state ao clicar" });
          } else {
            // Sem handler, sem efeito: morto de verdade.
            report.botoesQuebrados.push({ seletor: label, motivo: "botão morto: sem handler ligado e o clique não navega, não altera a página nem faz scroll" });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Timeout de clique / elemento tapado por overlay / instável = ARTEFACTO
          // do Playwright, NÃO um botão morto. Ex.: um botão de play sob o poster de
          // um <video>, ou sob um overlay intencional. Não faz a app chumbar — só
          // marca "morto" um botão que CLICA e não faz nada (testado acima).
          if (/Timeout|intercepts pointer events|not stable|outside of the viewport|element is not visible/i.test(msg)) continue;
          report.botoesQuebrados.push({ seletor: label, motivo: msg.slice(0, 120) });
        }
      }
    }

    // 4) Fim — erros de consola, botões mortos, forms quebrados ou controlos
    // não-testáveis (C6.4 — critério satisfazível: adicionar aria) → falha.
    // oracleSuspects NUNCA chumbam aqui (C6.5, política warn) — o chamador
    // decide (default: aviso honesto, sem alimentar `tentativas`).
    if (report.consoleErros.length > 0) report.ok = false;
    if (report.botoesQuebrados.length > 0) report.ok = false;
    if (report.formulariosQuebrados.length > 0) report.ok = false;
    if (report.naoTestaveis.length > 0) report.ok = false;

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
