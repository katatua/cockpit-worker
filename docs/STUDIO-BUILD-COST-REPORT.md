# Studio — Build Cost/Time Report (corrida das 20 apps PME, 2026-07-15)

> Fonte: logs do próprio Studio (`studio_orders`, `studio_messages`, `studio_events` na BD `thlqiuxptxliaumpmbeh`), corrida de 20 apps agénticas comissionadas via `/api/studio/commission`. Read-only, sem tocar nos builds a decorrer. Amostra = **5 apps concluídas** (todas tier `profundo`) + 2 em execução no momento.

## Método & ressalvas (ler primeiro)
- **`build_min`** = `last message` − `worker.arranque` (tempo real de construção). **`queue_min`** = `worker.arranque` − `created_at` (espera na fila; artefacto de 20 ordens num worker de 2-em-paralelo, NÃO é problema do motor).
- ⚠️ **`tokens_usados` não é fiável** nesta corrida (ver §3). Usar como ordem de grandeza, não como número.
- Todas as 5 terminaram em `estado='falhou'` (guarda de tempo) **mas com preview deployado e a funcionar** — ver §4.

## 1. Tabela por app (concluídas)
| App | build_min | queue_min | tokens (M) | milestones | commits |
|---|--:|--:|--:|--:|--:|
| relatorios-de-gestao | **151** | 169 | 1.9 | 10 | 2 |
| assistente-fiscal-pt | 106 | 74 | 10.0 | 10 | 1 |
| despesas-e-reembolsos | 92 | 78 | 8.1 | 10 | 1 |
| conciliacao-bancaria-ia | 75 | 4 | 16.0 | 11 | 1 |
| cobranca-autonoma | 70 | 6 | 16.4 | 6 | 1 |
| **média** | **~99** | — | ~10.5 (não fiável) | ~9 | ~1 |

## 2. Onde vai o tempo — anatomia por milestones
O tier profundo decompõe cada app numa sequência de **milestones** (`deep.milestone`), cada um com o seu próprio build (`buildOk`). Gaps observados:

- **cobranca** (6 milestones): 9, 6, 8, 11, 15 min entre milestones → ~10 min/milestone.
- **relatorios** (10 milestones): 8, 17, 10, 12, 12, 15, 12, 10, 14 min → ~12 min/milestone.

**Conclusões:**
- `fixRounds: 0` em **todos** os milestones das duas → **não há loops de correção de erros**. O tempo não é desperdiçado a arranjar builds partidos; é o custo intrínseco de N milestones em série.
- **Tempo de build ≈ nº de milestones × ~11 min.** O driver dominante do tempo é **quantos milestones o planeador cria**, e cada milestone corre um **build completo** (compilação Vite/Next repetida 6–11×).
- O nº de milestones é **inconsistente** para apps de complexidade parecida (cobranca 6 vs conciliacao 11 vs relatorios 10). O planeador não é estável no scope da decomposição → variância de 70→151 min.

## 3. Bug: contabilização de tokens não é fiável
`relatorios` correu **10 milestones** mas registou **1.9M tokens**; `cobranca` correu **6 milestones** e registou **16.4M**. Mais trabalho a custar 8× menos é impossível se o contador fosse correto. → **`tokens_usados` está a ser agregado de forma inconsistente** (provável: só conta parte das chamadas LLM, ou perde a soma quando a guarda de tempo mata o processo). **Corrigir a instrumentação antes de tomar qualquer decisão de custo.**

## 4. Bug de qualidade de dados: `falhou` num app que foi entregue
As 5 apps deployaram um preview real e funcional (verificado HTTP 200 + conteúdo semeado + JSON-LD), mas ficaram `estado='falhou'` com a mensagem "A demorar demasiado — parei para não gastar mais". A guarda de tempo dispara **depois** de o preview já estar no ar.
- Consequência: qualquer analítica/treino futuro sobre estes logs vê "100% falhado" quando na verdade foi "100% entregue". Envenena o dataset de melhoria do próprio Studio.
- A guarda também **não é um teto fixo** (disparou a 70, 75, 92, 106, 151 min) → está a medir algo por-passo, não wall-clock total coerente.

## 5. Bug menor de SEO
JSON-LD gerado com `"url":"http://localhost:3000"` em vez do domínio de produção (visto em `relatorios-de-gestao`). Base URL não injetada no template de metadata.

---

## Fixes priorizados (para o backlog do Studio)
**P0 — Instrumentação — ✅ FEITO E DEPLOYADO (commit `cedac69`, 2026-07-15)**
1. ✅ `agent.ts`: causa do sub-count era o `=` a esmagar a `usage` do result quando o SDK emite um 2.º result (error_during_execution) vazio. Passou a `Math.max` (mantém o pico cumulativo por run). *(Melhoria futura: gravar tokens por milestone num `deep.tokens` event.)*
2. ✅ `process.ts fail()`: se já há preview deployado e o motivo é tempo/budget, entrega como `preview_pronto` + event `worker.entregue_apos_budget`, em vez de `falhou`. Deixa de envenenar os logs. *(As 6 apps já concluídas antes do deploy ficam com o `falhou` histórico; da 7.ª em diante fica correto.)*

**P1 — Tempo (o driver é o nº de milestones × build repetido)**
3. **Estabilizar a decomposição**: teto de milestones por app (ex. 5–6) e planeador mais determinístico — 70 min (6 milestones) vs 151 min (10) para apps equivalentes é variância pura.
4. **Não recompilar tudo a cada milestone**: cache de build incremental / só type-check entre milestones e um build completo no fim. 6–11 compilações Vite/Next completas é onde vai grande parte do wall-clock.
5. **Guarda de tempo coerente**: um teto wall-clock explícito por ordem, e paragem *limpa* (fecha o milestone atual, deploya, marca overran) em vez de matar a meio.

**P2 — Qualidade**
6. Injetar base URL de produção no JSON-LD/metadata do template.

**Throughput da frota** (ortogonal ao motor): 2-em-paralelo num worker 512MB → 20 apps ≈ 12–15h. Se a frota for caso de uso recorrente, subir concorrência (com atenção a rate limits LLM + RAM) ou uma fila multi-worker.
