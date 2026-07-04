/**
 * Verificação pontual (`node dist/verify-aceitacao.js`): prova que o fallback
 * semântico marca como satisfeitos critérios de texto que a app cumpre com
 * outras palavras. Corre contra a app real do Mundial. Não é importado.
 */
const API = "https://api.anthropic.com/v1/messages";
const stripTags = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("VERIFY: sem ANTHROPIC_API_KEY"); process.exit(2); }
  const base = "https://mundial-2026-8u06dg7zs-claudios-projects-c3fe3407.vercel.app";
  const rotas = ["", "/simulador", "/jogos", "/grupos"];
  let texto = "";
  for (const r of rotas) {
    const resp = await fetch(base + r, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (resp?.ok) texto += " \n " + stripTags(await resp.text());
  }
  texto = texto.slice(0, 7000);
  // os 2 critérios que o check determinístico reprova (fraseado diferente)
  const reqs = [
    "Deve existir referência aos próximos jogos / jogos por disputar",
    "O simulador é apresentado como uma previsão do utilizador (não resultado real)",
  ];
  const lista = reqs.map((d, k) => `${k + 1}. ${d}`).join("\n");
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: "Verificas se o TEXTO DE UMA PÁGINA satisfaz requisitos, MESMO com palavras diferentes (ex.: 'jogos que faltam' ou 'calendário' satisfazem 'próximos jogos'; 'previsão' satisfaz 'previsão do utilizador'). Só marcas satisfeito se o conceito estiver MESMO presente. Responde SÓ com os números dos requisitos satisfeitos separados por vírgulas, ou 'nenhum'.",
      messages: [{ role: "user", content: `TEXTO DA PÁGINA:\n${texto}\n\nREQUISITOS:\n${lista}` }],
    }),
  });
  const j = await r.json() as { content?: { type: string; text?: string }[] };
  const out = j.content?.find((c) => c.type === "text")?.text ?? "(sem resposta)";
  console.log("VERIFY status=" + r.status);
  console.log("VERIFY texto_len=" + texto.length);
  console.log("VERIFY satisfeitos=" + out.trim());
})();
