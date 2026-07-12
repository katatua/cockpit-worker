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
| 1 | Tier `profundo` sem teto (iterações/tempo), gate biométrico no confirm | 🟡 | — |
| 2 | Pipeline multi-agente no build: arquiteto→implementador(es)→verificador | 🟡 | Opus/Sonnet/Opus |
| 3 | Oráculo forte: escreve+corre testes, conduz fluxos reais, lê logs | 🟡 | Sonnet/Opus |
| 4 | Provisionamento multi-serviço (Supabase/Fly/secrets/x402) | ⚪ desenho | — |
| 5 | Camada de plano/decomposição viva (PLAN.md no repo) | 🟡 | Opus |
| 6 | Contexto profundo: mapa do repo (árvore + símbolos) por fase | 🟡 | Haiku/código |

Legenda: ✅ feito · 🟡 em construção · ⚪ por fazer / bloqueado.

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
