/**
 * Fatia B · dicionário tool_use → frase humana.
 *
 * Cada action que o Agent SDK toma PODE virar uma mensagem `atividade` visível
 * ao 0-coder. O runlog do admin recebe sempre a linha crua; aqui traduzimos
 * para a coluna esquerda do Workspace.
 *
 * FILOSOFIA (upgrade 2026-07-06): comunicação VERDADEIRAMENTE agêntica.
 *  - Cada frase NOMEIA o objeto: "A criar a API transcribe", não "A criar route.ts";
 *    "A verificar os tipos", não "A correr uma verificação" (×40).
 *  - Encanamento puro (git, ls, mkdir, sed…) devolve `null` → INVISÍVEL. Silêncio
 *    vale mais que ruído genérico; o texto do próprio agente e o heartbeat cobrem
 *    o vazio. O que conta é o raciocínio dele (streamado à parte como `texto`).
 */

type ToolInput = Record<string, unknown>;

const basename = (p: unknown): string => {
  const s = typeof p === "string" ? p : String(p ?? "");
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
};

// Descreve um ficheiro pelo PAPEL, com contexto do diretório — para que 5
// `route.ts` diferentes não apareçam todos como "route.ts". Ex.:
//   app/api/transcribe/route.ts → "a API transcribe"
//   app/reunioes/[id]/page.tsx  → "a página reunioes/[id]"
//   lib/replicate.ts            → "a lib replicate"
const describeFile = (path: unknown): string => {
  const p = typeof path === "string" ? path : "";
  const b = basename(path);
  // Ficheiros de topo bem conhecidos.
  if (/^page\.(t|j)sx?$/i.test(b) && !/app\/.+\/page/i.test(p)) return "a página principal";
  if (/^layout\.(t|j)sx?$/i.test(b)) return "o layout geral";
  if (/^globals?\.css$/i.test(b)) return "os estilos";
  if (/^package\.json$/i.test(b)) return "as dependências";
  if (/^next\.config\.(m|c)?js$/i.test(b)) return "a configuração do Next";
  if (/^tailwind\.config\./i.test(b)) return "a configuração do Tailwind";
  if (/^AGENTS\.md$/i.test(b)) return "as instruções do projeto";
  if (/^ORDERS?\.md$/i.test(b)) return "o registo de ordens";
  if (/^README\.md$/i.test(b)) return "o README";
  if (/^SPEC\.md$/i.test(b)) return "a especificação";
  if (/^CHANGELOG\.md$/i.test(b)) return "o registo de alterações";
  if (/^DECISIONS\.md$/i.test(b)) return "o registo de decisões";
  // Rotas API: app/api/<nome>/route.ts → "a API <nome>".
  const api = p.match(/app\/api\/(.+?)\/route\.[tj]sx?$/i);
  if (api) return `a API ${api[1]}`;
  // Outras rotas de servidor: app/<seg>/route.ts → "a rota <seg>".
  const rota = p.match(/app\/(.+?)\/route\.[tj]sx?$/i);
  if (rota) return `a rota ${rota[1]}`;
  // Páginas aninhadas: app/<caminho>/page.tsx → "a página <caminho>".
  const pag = p.match(/app\/(.+?)\/page\.[tj]sx?$/i);
  if (pag) return `a página ${pag[1]}`;
  // Libs e componentes.
  const lib = p.match(/lib\/(.+?)\.[tj]sx?$/i);
  if (lib) return `a lib ${lib[1].replace(/\/index$/, "")}`;
  const comp = p.match(/components\/(.+?)\.[tj]sx?$/i);
  if (comp) return `o componente ${comp[1].replace(/\/index$/, "")}`;
  const hook = p.match(/hooks?\/(use[A-Za-z0-9-]+)\.[tj]sx?$/i);
  if (hook) return `o hook ${hook[1]}`;
  return b;
};

/** Devolve `null` se a action não vale a pena mostrar ao 0-coder. */
export function humanizeToolUse(name: string, input: ToolInput): string | null {
  // MCP → mostra só a intenção (não o nome completo mcp__server__tool).
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "servidor externo";
    const tool = parts.slice(2).join("__");
    if (/image|photo/i.test(tool)) return `A pedir uma imagem`;
    if (/video/i.test(tool)) return `A pedir um vídeo`;
    if (/qr/i.test(tool)) return `A gerar um QR code`;
    if (/scrape|extract|fetch|read/i.test(tool)) return `A ir buscar informação`;
    if (/email|sms/i.test(tool)) return `A preparar uma mensagem`;
    return `A usar uma capacidade externa (${server})`;
  }

  switch (name) {
    case "Read":
      return `A ler ${describeFile(input.file_path)}`;
    case "Write":
      return `A criar ${describeFile(input.file_path)}`;
    case "Edit":
      return `A alterar ${describeFile(input.file_path)}`;
    case "Glob":
      return `A procurar ficheiros`;
    case "Grep":
      return `A procurar por padrões`;
    case "WebSearch": {
      const q = typeof input.query === "string" ? input.query.slice(0, 70) : "";
      return q ? `A pesquisar na web: ${q}` : `A pesquisar na web`;
    }
    case "WebFetch":
      return `A consultar uma página na web`;
    case "Bash": {
      const cmdFull = String(input.command ?? "");
      const cmd = cmdFull.trim();
      const low = cmd.toLowerCase();
      // IMAGENS: o momento premium (estilo Base44 "Generated 8 images").
      if (/studio-image\.mjs/i.test(cmdFull)) {
        if (/--batch/i.test(cmdFull)) return `A gerar as imagens cinematográficas do site`;
        const m = cmdFull.match(/studio-image\.mjs\s+["']([^"']{3,70})/i);
        const nome = m ? m[1].replace(/,.*$/, "").trim() : null;
        return nome ? `A gerar a imagem: ${nome}` : `A gerar uma imagem cinematográfica`;
      }
      // ENCANAMENTO puro → invisível (silêncio > ruído genérico).
      if (/^(git|ls|cat|head|tail|pwd|cd|export|which|env|mkdir|mv|cp|rm|touch|chmod|sed|awk|tree|wc|sleep|true|clear|:)\b/i.test(cmd)) return null;
      // Comandos com SIGNIFICADO → nomeados pelo propósito real.
      if (/\btsc\b|type-?check|--noemit/i.test(low)) return `A verificar os tipos (TypeScript)`;
      if (/(npm|bun|pnpm|yarn)\s+run\s+build|next\s+build/i.test(low)) return `A construir a app`;
      if (/(npm|bun|pnpm|yarn)\s+run\s+dev|next\s+dev/i.test(low)) return `A arrancar a pré-visualização`;
      if (/\b(vitest|jest|playwright|npm\s+test|bun\s+test|smoke)\b/i.test(low)) return `A correr os testes`;
      if (/(npm|bun|pnpm|yarn)\s+(install|ci|add|i)\b/i.test(low)) return `A preparar os componentes`;
      if (/\b(psql|supabase|migrat|pg_dump|pg_restore)\b/i.test(low)) return `A preparar a base de dados`;
      // Testar um endpoint local por curl/wget.
      if (/^(curl|wget|http)\b/i.test(low)) {
        const u = cmdFull.match(/https?:\/\/[^\s"']*?\/(api\/[^\s"'?]+)/i);
        return u ? `A testar o endpoint /${u[1]}` : `A testar a app`;
      }
      // Correr um script (node/bun).
      const script = cmdFull.match(/\b(?:node|bun)\s+(?:--\S+\s+)*["']?([^\s"']+\.(?:mjs|cjs|js|ts))/i);
      if (script) return `A correr ${basename(script[1])}`;
      // Resto (encanamento não catalogado) → invisível.
      return null;
    }
    default:
      return null;
  }
}

/**
 * Frases do heartbeat — SÓ para o silêncio real (o LLM a pensar entre rajadas
 * de tools). Honestas e sem fingir atividade: nada de "A escrever o código…" /
 * "A ligar as peças…" (mentiam sobre o que estava a acontecer). A atividade
 * REAL vem via humanizeToolUse; o RACIOCÍNIO vem via o texto do próprio agente.
 * O heartbeat.ts escala da 1ª para a 2ª e depois cala-se (não faz spam).
 */
export const HEARTBEAT_PHRASES = [
  "A pensar no próximo passo…",
  "Ainda a trabalhar neste passo — é dos mais demorados…",
];
