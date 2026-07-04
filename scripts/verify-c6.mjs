#!/usr/bin/env node
/**
 * verify C6 — prova executável da spec (correcoes-arquitetura-studio.md).
 *
 * Serve a fixture-c6.html num HTTP local e corre o smokeTest compilado:
 *   1. sementeira (2 itens) + zero falsos positivos nos controlos com aria
 *   2. botão genuinamente morto → botoesQuebrados (distinto de suspect)
 *   3. seletor sem estado a11y → naoTestaveis ("não-testável", não "morto")
 *   4. consola limpa na fixture semeada
 *   5. filtro com efeito ilegível (title) → oracleSuspects, ordem não chumba
 *      por ele (ok=false aqui vem APENAS do morto + não-testável injetados)
 *
 * Uso: node scripts/verify-c6.mjs   (corre `npm run build` antes, precisa dist/)
 * Em macOS define PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH para o Chrome local.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, "fixture-c6.html"), "utf8");
const { smokeTest } = await import(join(dir, "..", "dist", "smoke.js"));

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const rel = await smokeTest(url, ["/"]);
server.close();

const falhas = [];
const ok = (cond, nome, detalhe) => {
  console.log(`${cond ? "✓" : "✗"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas.push(nome);
};

// 1 · sementeira + zero falsos positivos nos controlos saudáveis
ok(rel.sementes >= 2, "C6.2 sementeira ≥2 itens", `sementes=${rel.sementes}`);
const saudaveisFlagged = [...rel.botoesQuebrados, ...rel.naoTestaveis]
  .filter((b) => /Todas|Ativas|Conclu|Alta|Média|Baixa/.test(b.seletor));
ok(saudaveisFlagged.length === 0, "C6.1/C6.3 zero falsos positivos (filtros+chips com aria)",
  saudaveisFlagged.map((b) => b.seletor).join(", ") || "nenhum");

// 2 · botão morto injetado é apanhado como MORTO
const morto = rel.botoesQuebrados.find((b) => /Exportar/.test(b.seletor));
ok(!!morto && /morto/.test(morto.motivo), "verify#2 botão morto detetado como morto", morto?.motivo);

// 3 · seletor sem a11y → não-testável (mensagem distinta)
const naoTestavel = rel.naoTestaveis.find((b) => /Ordenar/.test(b.seletor));
ok(!!naoTestavel, "verify#3 controlo sem aria → não-testável", naoTestavel?.motivo);
ok(!rel.botoesQuebrados.some((b) => /Ordenar/.test(b.seletor)), "verify#3 …e NÃO como morto");

// 4 · consola limpa
ok(rel.consoleErros.length === 0, "verify#4 consola limpa", rel.consoleErros[0]);

// 5 · efeito ilegível → oracle-suspect (não morto, não não-testável)
const suspect = rel.oracleSuspects.find((b) => /compacto/i.test(b.seletor));
ok(!!suspect, "verify#5 efeito ilegível → oracle-suspect", suspect?.motivo);
ok(!rel.botoesQuebrados.some((b) => /compacto/i.test(b.seletor)) &&
   !rel.naoTestaveis.some((b) => /compacto/i.test(b.seletor)),
   "verify#5 …não classificado morto/não-testável");

console.log(`\nreport: botões=${rel.botoesTestados} quebrados=${rel.botoesQuebrados.length} naoTestaveis=${rel.naoTestaveis.length} suspects=${rel.oracleSuspects.length} sementes=${rel.sementes} ok=${rel.ok}`);
if (falhas.length) { console.error(`\nVERIFY C6: VERMELHO (${falhas.length}): ${falhas.join(" | ")}`); process.exit(1); }
console.log("\nVERIFY C6: VERDE");
