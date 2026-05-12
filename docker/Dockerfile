FROM oven/bun:1.3.11-alpine

RUN apk add --no-cache wget git

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .

RUN chmod +x src/cli.ts && ln -sf /app/src/cli.ts /usr/local/bin/maw

# Install maw-plugin-registry — the federation test container needs `maw init`,
# `maw peers add`, `maw peers probe` etc. which live in the registry, not the
# 13 core plugins built into maw-js. Clone the registry and symlink each plugin
# directory into $MAW_HOME/plugins so the maw CLI auto-discovers them. (#1252)
RUN git clone --depth 1 https://github.com/Soul-Brews-Studio/maw-plugin-registry /opt/plugin-registry \
    && cd /opt/plugin-registry \
    && bun install --frozen-lockfile \
    && mkdir -p /root/.maw/plugins \
    && for p in plugins/*; do \
         [ -d "$p" ] && ln -sf "/opt/plugin-registry/$p" "/root/.maw/plugins/$(basename "$p")"; \
       done

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
