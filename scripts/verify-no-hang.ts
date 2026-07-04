/**
 * verify-no-hang.ts — C3 (delta arquitetural 2026-07-04).
 *
 * Prova: 5 ordens triviais REAIS seguidas concluem sem intervenção do
 * watchdog (zero eventos `agente.hang`), e cada iteração fica < 5 min.
 *
 * Método: insere 5 ordens triviais em em_fila numa app de teste (serializam
 * pelo lock por-app), espera cada uma chegar a preview_pronto/falhou, e no
 * fim valida na BD: (a) nenhuma gerou agente.hang; (b) duração runlog
 * init→result < 300s por iteração; (c) nenhuma falhou por "demorou muito".
 *
 * Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/verify-no-hang.ts [slug]
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const slug = process.argv[2] ?? "site-teste-seed";
if (!url || !key) { console.error("✗ env em falta"); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

let falhas = 0;
function check(nome: string, ok: boolean, detalhe?: string) {
  if (ok) console.log(`  ✓ ${nome}`);
  else { console.error(`  ✗ ${nome}${detalhe ? ` — ${detalhe}` : ""}`); falhas++; }
}

async function main() {
  const { data: app } = await db.from("studio_apps").select("id, user_id").eq("slug", slug).single();
  if (!app) { console.error("✗ app não existe"); process.exit(1); }

  const textos = [
    "Muda o título da página inicial para «Site Teste Seed v2».",
    "Acrescenta ao rodapé o texto «Feito com o Studio».",
    "Muda o texto do parágrafo da página /sobre para descrever um site de demonstração do Studio.",
    "Acrescenta na página inicial uma linha por baixo do título a dizer «verificação C3».",
    "Muda o título da página /sobre para «Sobre este site».",
  ];
  const ids: string[] = [];
  for (const texto of textos) {
    const { data } = await db.from("studio_orders").insert({
      app_id: app.id, user_id: app.user_id, texto, modo: "build", estado: "em_fila",
    }).select("id").single();
    ids.push(data!.id);
    console.log(`→ ordem ${data!.id.slice(0, 8)}: ${texto.slice(0, 50)}…`);
  }

  // Espera todas terminarem (serializam pelo lock por-app). Timeout 90 min.
  const t0 = Date.now();
  while (Date.now() - t0 < 90 * 60_000) {
    const { data: rows } = await db.from("studio_orders").select("id, estado").in("id", ids);
    const terminadas = (rows ?? []).filter((r) => ["preview_pronto", "publicado", "falhou", "cancelado"].includes(r.estado));
    process.stdout.write(`\r  ${terminadas.length}/5 terminadas · ${Math.round((Date.now() - t0) / 60000)}min   `);
    if (terminadas.length === ids.length) break;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  console.log("");

  // (a) zero agente.hang nestas ordens
  const { data: hangs } = await db.from("studio_events").select("order_id, payload").eq("tipo", "agente.hang").in("order_id", ids);
  check("zero eventos agente.hang", (hangs ?? []).length === 0, JSON.stringify((hangs ?? []).map((h) => h.payload)).slice(0, 200));

  // (b) todas preview_pronto (nenhuma falhou por timeout)
  const { data: fin } = await db.from("studio_orders").select("id, estado, erro").in("id", ids);
  for (const o of fin ?? []) {
    check(`ordem ${o.id.slice(0, 8)} concluiu (${o.estado})`, o.estado === "preview_pronto", o.erro ?? "");
  }

  // (c) duração por iteração < 5 min: mede init→result no runlog de cada ordem
  for (const id of ids) {
    const { data: linhas } = await db.from("studio_runlog").select("linha, created_at").eq("order_id", id).or("linha.like.sdk:init%,linha.like.sdk:result%").order("created_at");
    const pares: number[] = [];
    let inicio: number | null = null;
    for (const l of linhas ?? []) {
      if (l.linha.startsWith("sdk:init")) inicio = new Date(l.created_at).getTime();
      if (l.linha.startsWith("sdk:result") && inicio) { pares.push((new Date(l.created_at).getTime() - inicio) / 1000); inicio = null; }
    }
    const max = Math.max(...(pares.length ? pares : [Infinity]));
    check(`ordem ${id.slice(0, 8)}: iterações ${pares.map((p) => Math.round(p) + "s").join(", ") || "—"} (< 300s)`, pares.length > 0 && max < 300);
  }

  if (falhas > 0) { console.error(`✗ verify-no-hang: ${falhas} falhas`); process.exit(1); }
  console.log("✓ verify-no-hang VERDE — 5 ordens reais sem watchdog, iterações < 5 min");
}
main();
