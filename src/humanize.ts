/**
 * Fatia B · dicionário tool_use → frase humana.
 *
 * Cada action que o Agent SDK toma vira uma mensagem `atividade` visível
 * ao 0-coder. O runlog do admin continua a receber a linha crua; aqui
 * traduzimos para a coluna esquerda do Workspace.
 */

type ToolInput = Record<string, unknown>;

const basename = (p: unknown): string => {
  const s = typeof p === "string" ? p : String(p ?? "");
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
};

const describeFile = (path: unknown): string => {
  const b = basename(path);
  if (/^page\.(t|j)sx?$/i.test(b)) return "a página principal";
  if (/^layout\.(t|j)sx?$/i.test(b)) return "o layout geral";
  if (/^globals?\.css$/i.test(b)) return "os estilos";
  if (/^package\.json$/i.test(b)) return "as dependências";
  if (/^AGENTS\.md$/i.test(b)) return "as instruções do projeto";
  if (/^SPEC\.md$/i.test(b)) return "a especificação";
  if (/^CHANGELOG\.md$/i.test(b)) return "o registo de alterações";
  if (/^DECISIONS\.md$/i.test(b)) return "o registo de decisões";
  // ex: app/carrinho/page.tsx → "a página carrinho"
  const pathStr = typeof path === "string" ? path : "";
  const seg = pathStr.match(/app\/([^\/]+)\/page\.[tj]sx?/i);
  if (seg) return `a página ${seg[1]}`;
  const compMatch = pathStr.match(/components\/([^\/]+)\.[tj]sx?/i);
  if (compMatch) return `o componente ${compMatch[1]}`;
  return b;
};

/** Devolve `null` se a action não vale a pena mostrar ao 0-coder. */
export function humanizeToolUse(name: string, input: ToolInput): string | null {
  // MCP → mostra só o servidor (não o nome completo mcp__server__tool)
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "servidor externo";
    const tool = parts.slice(2).join("__");
    if (/image|photo/i.test(tool)) return `A pedir uma imagem`;
    if (/video/i.test(tool)) return `A pedir um vídeo`;
    if (/qr/i.test(tool)) return `A gerar um QR code`;
    if (/scrape|extract|fetch/i.test(tool)) return `A ir buscar informação`;
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
      const q = typeof input.query === "string" ? input.query.slice(0, 60) : "";
      return q ? `A pesquisar na web: ${q}` : `A pesquisar na web`;
    }
    case "WebFetch":
      return `A consultar uma página na web`;
    case "Bash": {
      const cmdFull = String(input.command ?? "");
      const cmd = cmdFull.slice(0, 60);
      // IMAGENS: é o momento premium (estilo Base44 "Generated 8 images").
      if (/studio-image\.mjs/i.test(cmdFull)) {
        if (/--batch/i.test(cmdFull)) return `A gerar as imagens cinematográficas do site`;
        // modo único: extrai o prompt (1º argumento entre aspas) para nomear.
        const m = cmdFull.match(/studio-image\.mjs\s+["']([^"']{3,70})/i);
        const nome = m ? m[1].replace(/,.*$/, "").trim() : null; // 1ª cláusula do prompt
        return nome ? `A gerar a imagem: ${nome}` : `A gerar uma imagem cinematográfica`;
      }
      if (/^git /i.test(cmd)) return null; // git é ruído para o 0-coder
      if (/npm (install|ci|add)/i.test(cmd)) return `A preparar os componentes`;
      if (/npm run (build|dev)/i.test(cmd)) return `A construir`;
      if (/npm test/i.test(cmd)) return `A correr verificações`;
      if (/^ls|^cat|^find/i.test(cmd)) return null; // exploração
      return `A correr uma verificação`;
    }
    default:
      return null;
  }
}

/**
 * Frases rotativas do heartbeat. O worker manda uma a cada 8s se não
 * houver actividade recente durante `em_execucao`. Ordenadas para dar
 * sentido de progresso mesmo sendo genéricas.
 */
export const HEARTBEAT_PHRASES = [
  "Ainda a pensar…",
  "A explorar a melhor abordagem…",
  "A analisar o que já existe…",
  "A juntar as peças…",
  "A polir os detalhes…",
  "Quase lá…",
];
