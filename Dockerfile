# syntax=docker/dockerfile:1

FROM node:24-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force


FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.title="Watch Together" \
      org.opencontainers.image.description="一起看：同步视频放映厅" \
      org.opencontainers.image.source="https://github.com/luvhx/watch-together" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8364 \
    HOST=0.0.0.0

WORKDIR /app

RUN apk add --no-cache ffmpeg \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && addgroup -S -g 1001 watch \
    && adduser -S -D -H -u 1001 -G watch watch

COPY --from=dependencies --chown=watch:watch /app/node_modules ./node_modules
COPY --chown=watch:watch package.json ./
COPY --chown=watch:watch server ./server
COPY --chown=watch:watch public ./public

USER watch

EXPOSE 8364
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8364)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
