# Container-native oracle prototype (#627 scope expansion).
#
# Ships a Claude-Code runtime with a maw-js oracle identity, federating to a
# host maw-server over the compose network. Differs from docker/Dockerfile:
#   - debian base (not alpine) so `npm i -g @anthropic-ai/claude-code` works
#   - claude-code pre-installed at the system level
#   - non-root user `oracle` with a persistent $HOME for identity + .claude
#   - entrypoint registers with $HOST_MAW_URL instead of bootstrapping 2 peers
FROM oven/bun:1.3.11

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates curl git gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# claude-code ships as an npm package and its bundled shim expects `node`
# on PATH at runtime, so we install node (not just bun). The `|| true` lets
# the build succeed even if --version runs before ANTHROPIC_API_KEY is set.
RUN npm install -g @anthropic-ai/claude-code@latest \
 && claude --version || true

RUN useradd --create-home --shell /bin/bash oracle

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/sdk/package.json packages/sdk/
RUN bun install --frozen-lockfile

COPY . .

RUN chmod +x src/cli.ts \
 && ln -sf /app/src/cli.ts /usr/local/bin/maw \
 && chown -R oracle:oracle /app \
 && mkdir -p /home/oracle/.claude /home/oracle/.maw \
 && chown -R oracle:oracle /home/oracle

COPY docker/oracle-container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER oracle

ENV HOME=/home/oracle \
    MAW_HOME=/home/oracle/.maw \
    CLAUDE_CONFIG_DIR=/home/oracle/.claude \
    ORACLE_NAME= \
    HOST_MAW_URL=http://host-maw:3456 \
    HOST_MAW_ALIAS=host \
    IDLE_INTERVAL_SECONDS=60

# Container oracle also serves /info so the host can probe it back — that's
# what makes it appear as a peer rather than a one-way client.
EXPOSE 3456

HEALTHCHECK --interval=5s --retries=20 \
  CMD wget -qO- http://localhost:3456/api/plugins || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["maw", "serve", "3456"]
