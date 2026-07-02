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
RUN git config --global user.email "worker@myvibepro.dev" && git config --global user.name "Cockpit Studio Worker"
CMD ["node", "dist/index.js"]
