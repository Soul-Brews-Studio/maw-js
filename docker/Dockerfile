FROM oven/bun:1.3.11-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .

RUN chmod +x src/cli.ts && ln -sf /app/src/cli.ts /usr/local/bin/maw

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV MAW_HOME=/root/.maw \
    NODE_NAME=node-a \
    PEER_URL=http://node-b:3456 \
    PEER_ALIAS=peer

EXPOSE 3456

HEALTHCHECK --interval=5s --retries=20 \
  CMD wget -qO- http://localhost:3456/api/plugins || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["maw", "serve", "3456"]
