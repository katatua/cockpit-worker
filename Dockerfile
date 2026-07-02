# Studio worker · imagem Fly (região cdg, background persistente + HTTP router).
# Precisa git + Node 22 + Chromium (Playwright smoke tests do quality gate F5.2).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
# git é obrigatório: o worker faz clone/commit/push do repo de cada app.
# chromium + libs de sistema para Playwright headless (Brief §4.6 F5.2).
# Removemos o cache de npm para não inflar a imagem.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Playwright usa esta env para não tentar descarregar o browser (usamos o chromium do apt).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Git identity: email verificado no GitHub (COMMIT_AUTHOR_REQUIRED da Vercel).
RUN git config --global user.email "gravitnomad@gmail.com" && git config --global user.name "katatua"

CMD ["node", "dist/index.js"]
