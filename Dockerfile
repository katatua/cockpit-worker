# Studio worker · imagem para Fly.io (região arn, background persistente)
# Precisa de git + node 22 (WebSocket nativo para @supabase/realtime-js).
# Sem servidor HTTP — é um worker de fila.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
# git é obrigatório: o worker faz clone/commit/push do repo de cada app.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Nome+email do git para os commits que o agente faz.
# IMPORTANTE: email TEM de ser reconhecido pelo GitHub como pertencente a um user real,
# senão o Vercel bloqueia deploy com COMMIT_AUTHOR_REQUIRED. Usar o email primary do
# GitHub user 'katatua' (o dono actual da conta). Quando SaaS-0 chegar (OAuth por
# user), este ficará dinâmico via env var GIT_AUTHOR_EMAIL do secret do user.
RUN git config --global user.email "gravitnomad@gmail.com" && git config --global user.name "katatua"
CMD ["node", "dist/index.js"]
