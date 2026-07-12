# Studio → réplica do Claude Code — Roadmap & GAPS

> Objetivo (mandato do Cláudio, 2026-07-12): o Studio deve construir apps de
> complexidade arbitrária (até tão complexas como o próprio Studio),
> autonomamente, sem perguntas. Fila de trabalho + estado real aqui.
> Disciplina de modelos: Opus = arquitetura/verificação/bugs · Sonnet =
> implementação mecânica · Haiku = trivial/barato.

## Diagnóstico: porque o Studio não fazia apps complexas

O cérebro já é o mesmo (claude-agent-sdk + mesmos modelos + mesmas tools). O
teto era a **jaula** à volta:

1. Teto de tempo/iterações (`MAX_ITER=8`, `BUDGET_MS=12min`) — afinado p/ 1 edição.
2. Uma app / um repo / um framework (Next+Vercel); sem multi-serviço.
3. Sem ambiente real / segredos / provisionamento de integrações.
4. Oráculo raso (link check + smoke + presença de texto) — não certifica lógica.
5. Sem decomposição/arquitetura — 1 agente, 1 passagem, lista plana de features.
6. Contexto raso do codebase-alvo — sem mapa/RAG.

## Plano (tier `profundo`, aditivo — não regride o tier simples)

| # | Peça | Estado | Modelo |
|---|------|--------|--------|
| 1 | Tier `profundo` sem teto (orçamento tempo 4h em vez de 12min) | ✅ worker · 🟡 gate biométrico (cockpit) | — |
| 2 | Pipeline multi-agente: arquiteto→implementador→verificador (deep-build.ts) | ✅ construído, em teste E2E | Opus/Sonnet/Opus |
| 3 | Oráculo forte: build gate por milestone + verificador corre testes/revê diff | 🟡 (build+verify sim; testes só se existirem) | Sonnet/Opus |
| 4 | Provisionamento multi-serviço (Supabase/Fly/secrets/x402) | ⚪ desenho abaixo | — |
| 5 | Plano/decomposição vivo (PLAN.md + .studio/plan.json no repo) | ✅ construído | Opus |
| 6 | Contexto profundo: mapa do repo (árvore + símbolos exportados) | ✅ construído (determinístico) | código |

Legenda: ✅ feito · 🟡 parcial/em teste · ⚪ por fazer / bloqueado.

### Desenho do #4 (provisionamento) — porque fica para depois do teste

O worker constrói UM Next.js e deploya para UM Vercel. Uma app complexa "a sério"
precisa de serviços reais (BD, auth, filas). Fatia segura (a fazer): a build
DECLARA os recursos de que precisa (`.studio/requires.json` = env vars + porquê +
onde obter) e o worker emite evento + mensagem honesta; o dono preenche no Vercel
(ou Cofre) — nunca o agente inventa segredos. Fatia completa (bloqueada por risco
de infra real, decisão de tocar em produção): criar projeto Supabase / máquina Fly
/ x402 a partir do agente, atrás de biometria. **Nota dura (memória):** o Supabase
Free só deixa 2 projetos ativos — auto-provisionar Supabase precisa de plano pago.

### GAPS cross-repo (cockpit) — runbook para amanhã

- **Gate biométrico no confirm de builds profundos** (regra do dono: biometria p/
  gastar). Vive em `cockpit/app/api/studio/orders/[id]/confirm/route.ts` — exigir
  WebAuthn quando `order.tier='profundo'`. Hoje o worker já honra o tier; falta a
  fricção biométrica no clique "Avançar".
- **Propagar tier em app_nova**: `confirm/route.ts` cria a ordem nova sem `tier`;
  passar `order.tier` para a ordem da app nova.
- **Badge de tier na UI** (`Workspace.tsx`): mostrar "build profundo" no card.

## Decisões de arquitetura (tomadas autonomamente)

- **Aditividade**: tier `simples` (atual) intocado. `profundo` é um caminho novo
  em `deep-build.ts`, escolhido por `studio_orders.tier`.
- **Deteção de tier**: o interpretador classifica `complexidade`
  (simples|complexa); complexa → tier `profundo`. Override manual possível.
- **Orquestração explícita** (não subagentes internos do SDK, para controlo):
  o worker corre N chamadas `runAgent` com papéis e modelos distintos, sobre o
  MESMO worktree, e faz o loop implement↔verify.
- **Sem teto real**: deep tier usa orçamento de tempo largo (horas) em vez de
  `MAX_ITER`; kill-switch do dono continua a valer.
- **Gates existentes mantêm-se** como rede de segurança final pós-deploy.

## Log de execução (mais recente primeiro)

- 2026-07-12: início. Fundação do tier + pipeline deep-build.
