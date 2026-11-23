# Node 20 según SPEC. Node 20 llegó a fin de soporte (abril 2026):
# podés construir con otra versión con --build-arg NODE_VERSION=22 (o 24).
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim

# FFmpeg (con libwebp) para la conversión a stickers
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    AUTH_DIR=/app/auth_info

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/auth_info /app/tmp && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reenvía SIGTERM/SIGINT al proceso de Node para un apagado limpio
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
