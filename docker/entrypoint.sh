#!/bin/sh
# docker/entrypoint.sh — PID 1 bootstrap for the federation test container.
#
# Bootstrap order:
#   1. Ensure HOME and MAW_HOME exist ($MAW_HOME/peers.json is the peers store).
#   2. If maw.config.json is missing, write it DIRECTLY as JSON. (Pre-#TBD this
#      ran `maw init --non-interactive`, but `init` lives in maw-plugin-registry
#      which is not installed in this test image — only the 13 legacy plugins
#      built into maw-js ship here. Calling `maw init` errored with "unknown
#      command: init" and the container never reached healthy.)
#   3. If PEER_URL is set, write peers.json DIRECTLY as JSON. (Same reason —
#      `maw peers add` lives in plugin-registry. The shape matches PeersFile
#      from maw-plugin-registry/plugins/peers/store.ts.)
#   4. exec "$@" so the CMD (e.g. `maw serve`) becomes PID 1 and receives
#      SIGTERM directly from the container runtime.
#
# Why not install plugin-registry in the image? Two reasons:
#   - This test only exercises `maw serve` + the /info handshake (which uses
#     core, not plugin-registry). Bootstrap doesn't need a real `maw init`.
#   - Cloning + linking plugin-registry adds a second-repo build dependency
#     that would couple Dockerfile to a different release cadence. Follow-up:
#     issue tracks the architecturally-correct fix.
set -eu

: "${HOME:=/root}"
export HOME

: "${MAW_HOME:=$HOME/.maw}"
: "${NODE_NAME:=$(hostname)}"
: "${PEER_ALIAS:=peer}"

mkdir -p "$MAW_HOME" "$HOME/.config/maw"

CONFIG_FILE="$HOME/.config/maw/maw.config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<EOF
{
  "host": "local",
  "node": "$NODE_NAME",
  "port": 3456
}
EOF
fi

if [ -n "${PEER_URL:-}" ]; then
  PEERS_FILE="$MAW_HOME/peers.json"
  ADDED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  cat > "$PEERS_FILE" <<EOF
{
  "version": 1,
  "peers": {
    "$PEER_ALIAS": {
      "url": "$PEER_URL",
      "node": null,
      "addedAt": "$ADDED_AT",
      "lastSeen": null
    }
  }
}
EOF
fi

echo "[${NODE_NAME}] bootstrap complete — peers.json:"
cat "$MAW_HOME/peers.json" 2>/dev/null || echo "(no peers.json yet)"

# Force 0.0.0.0 bind even if peers.json hasn't been populated yet (#616).
# maw serve's resolveBindHost() treats MAW_HOST="0.0.0.0" as an explicit
# opt-in. Without this, a container whose first `maw peers add` failed
# (peer not up yet) would stay on loopback and be unreachable for retry.
export MAW_HOST=0.0.0.0

exec "$@"
