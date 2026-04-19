#!/bin/bash
# docker/oracle-container/entrypoint.sh — PID 1 for a container-native oracle.
#
# Bootstrap order:
#   1. Ensure $HOME, $MAW_HOME, $CLAUDE_CONFIG_DIR exist (volume-mounted).
#   2. Load-or-mint oracle identity at $CLAUDE_CONFIG_DIR/identity.json.
#      Node name precedence: $ORACLE_NAME env > identity.json.node > random stem.
#      This persists across `docker compose down && up` via the named volume.
#      (Full keypair identity is deferred to the rfc-identity RFC — see
#       README "NOT DONE" for scope.)
#   3. If peers.json missing, run `maw init --non-interactive --node <name>`.
#   4. Register the host as a peer with --allow-unreachable (the host may not
#      have finished booting yet when we first come up — the host-side probe
#      fills in the return edge when it registers us).
#   5. exec "$@" so `maw serve` becomes PID 1 and receives SIGTERM cleanly.
#
# The CMD default (`maw serve 3456`) makes this container a symmetric peer:
# it can probe the host AND be probed back, which is what lets it show up
# in `maw peers list` on the host.
set -eu

: "${HOME:=/home/oracle}"
export HOME
: "${MAW_HOME:=$HOME/.maw}"
: "${CLAUDE_CONFIG_DIR:=$HOME/.claude}"
: "${HOST_MAW_ALIAS:=host}"
: "${HOST_MAW_URL:=http://host-maw:3456}"
: "${IDLE_INTERVAL_SECONDS:=60}"

mkdir -p "$MAW_HOME" "$CLAUDE_CONFIG_DIR"

# --- identity load-or-mint -------------------------------------------------
IDENTITY_FILE="$CLAUDE_CONFIG_DIR/identity.json"
if [ -f "$IDENTITY_FILE" ]; then
  STORED_NAME=$(grep -o '"node"[[:space:]]*:[[:space:]]*"[^"]*"' "$IDENTITY_FILE" | sed 's/.*"\([^"]*\)"$/\1/')
else
  STORED_NAME=""
fi

if [ -n "${ORACLE_NAME:-}" ]; then
  NODE_NAME="$ORACLE_NAME"
elif [ -n "$STORED_NAME" ]; then
  NODE_NAME="$STORED_NAME"
else
  # `tr -dc` fails on /dev/urandom streams with SIGPIPE after enough bytes;
  # head first to bound the read so set -e doesn't abort the bootstrap.
  STEM=$(head -c 32 /dev/urandom | tr -dc 'a-z0-9' | head -c 6 || true)
  NODE_NAME="oracle-${STEM:-anon}"
fi

if [ ! -f "$IDENTITY_FILE" ] || [ "$STORED_NAME" != "$NODE_NAME" ]; then
  cat > "$IDENTITY_FILE" <<JSON
{
  "schema": "0",
  "node": "$NODE_NAME",
  "born": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "prototype identity — keypair deferred to rfc-identity RFC (#629)"
}
JSON
fi

echo "[container-oracle] identity → $NODE_NAME ($IDENTITY_FILE)"

# --- maw init (idempotent-ish: --force re-writes, but we gate on peers.json)
if [ ! -f "$MAW_HOME/peers.json" ]; then
  maw init --non-interactive --node "$NODE_NAME" --force
fi

# --- register host as peer -------------------------------------------------
# --allow-unreachable: host may not be up yet on first compose boot. The host
# side adds us back when IT boots, so the edge closes either way.
maw peers add "$HOST_MAW_ALIAS" "$HOST_MAW_URL" --allow-unreachable || true

echo "[container-oracle] bootstrap complete — peers.json:"
cat "$MAW_HOME/peers.json" 2>/dev/null || echo "(no peers.json yet)"

# Required for the host container to reach us over the compose network.
export MAW_HOST=0.0.0.0

# Background re-probe loop so stale entries self-heal if the host flaps.
# Sends a `maw peers probe` every $IDLE_INTERVAL_SECONDS; stays detached
# from stdout so it doesn't interleave with the serve logs.
(
  while sleep "$IDLE_INTERVAL_SECONDS"; do
    maw peers probe "$HOST_MAW_ALIAS" >/dev/null 2>&1 || true
  done
) &

exec "$@"
