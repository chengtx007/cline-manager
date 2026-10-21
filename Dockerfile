# syntax=docker/dockerfile:1
FROM node:22-alpine

LABEL org.opencontainers.image.title="cline-manager" \
      org.opencontainers.image.description="OpenAI-compatible gateway for Cline Pass with multi-account rotation, quota-aware failover and provider pinning" \
      org.opencontainers.image.source="https://github.com/chengtx007/cline-manager" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787

COPY package.json server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
