# Cockpit Studio Worker

Background worker do módulo Studio do [Cockpit](https://github.com/katatua/cockpit). Corre num processo persistente (Fly.io, região `arn`) e faz poll a `studio_orders WHERE estado='em_fila'`. Para cada ordem:

1. Adquire lock atómico (`studio_locks`)
2. Clone shallow do repo da app (branch `studio/<orderId>`)
3. Corre `@anthropic-ai/claude-agent-sdk` no worktree com system prompt do repo (AGENTS.md + SPEC.md)
4. `git commit` + `push` da branch
5. Poll ao Vercel até deploy de preview `READY`
6. Escreve `preview_url` REAL na ordem, estado → `preview_pronto`

**Falha honesta em todos os passos.** Nunca fabrica URLs, commits ou branches.

## Deploy no Fly.io

Repo é `katatua/cockpit-worker`. Fly deteta o `Dockerfile` e faz build automático.

### Secrets a configurar no Fly

```bash
fly secrets set \
  SUPABASE_URL=https://thlqiuxptxliaumpmbeh.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  ANTHROPIC_API_KEY=... \
  GITHUB_TOKEN=... \
  VERCEL_TOKEN=...
```

Ou via UI: Fly dashboard → Secrets → Add.

## Dev local

```bash
cp .env.example .env       # preencher com os valores reais
npm install
npm run dev                # tsx src/index.ts
```

O worker liga-se ao **mesmo Supabase** que o cockpit em produção — vais processar as ordens verdadeiras do 0-coder. Cuidado se estiveres a testar.

## Guardrails

- `MAX_TOKENS_PER_ORDER` (default 200k) — aborta ordem se exceder
- `DEPLOY_TIMEOUT_S` (default 180s) — deploy que não ficar READY em 3 min → falhou
- `permissionMode`: `plan` em modo chat (read-only), `acceptEdits` em build
- `allowedTools`: mínimas (`Read/Write/Edit/Glob/Grep/Bash` em build; só leitura em chat)

## Estrutura

```
src/
  index.ts       loop principal + graceful shutdown
  config.ts      env vars com validação (fail-closed)
  db.ts          supabase service-role client + helpers
  git.ts         spawn git com token no URL
  vercel.ts      poll deployments preview até READY
  agent.ts       wrapper query() + tokens + guardrail
  process.ts     fluxo end-to-end de uma ordem
```
