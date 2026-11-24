FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY src ./src
COPY public ./public

# Clipes (volume compartilhado com o gravador, mesmo UID 1000) e banco de dados
RUN mkdir -p /data/clips /data/app && chown node:node /data/clips /data/app

USER node
EXPOSE 3000
# start-interval: checa a cada 2s logo após iniciar, pro Traefik liberar o tráfego rápido
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/start.js"]
