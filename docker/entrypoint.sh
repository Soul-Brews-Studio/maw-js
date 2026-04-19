#!/bin/sh
# docker/entrypoint.sh — PID 1 bootstrap for the federation test container.
#
# Bootstrap order:
#   1. Ensure HOME and MAW_HOME exist ($MAW_HOME/peers.json is the peers store).
#   2. If peers.json is missing, run `maw init --non-interactive --force` to
#      write ~/.config/maw/maw.config.json. (init does NOT create peers.json —
#      that only happens on the first successful `maw peers add`.)
#   3. Register the peer via `maw peers add` — tolerant on restart with the
#      same volume (add overwrites cleanly; `|| true` swallows probe failures
#      when the peer container hasn't come up yet).
#   4. exec "$@" so the CMD (e.g. `maw serve`) becomes PID 1 and receives
#      SIGTERM directly from the container runtime.
#
# `maw init` supports --non-interactive with --node/--ghq-root/--force/--federate
# flags (src/commands/plugins/init/non-interactive.ts). No stdin blocking.
set -eu

: "${HOME:=/root}"
export HOME

: "${MAW_HOME:=$HOME/.maw}"
: "${NODE_NAME:=$(hostname)}"
: "${PEER_ALIAS:=peer}"

mkdir -p "$MAW_HOME"

if [ ! -f "$MAW_HOME/peers.json" ]; then
  maw init --non-interactive --node "$NODE_NAME" --force
fi

if [ -n "${PEER_URL:-}" ]; then
  maw peers add "$PEER_ALIAS" "$PEER_URL" || true
fi

echo "[${NODE_NAME}] bootstrap complete — peers.json:"
cat "$MAW_HOME/peers.json" 2>/dev/null || echo "(no peers.json yet)"

# Force 0.0.0.0 bind even if peers.json hasn't been populated yet (#616).
# maw serve's resolveBindHost() treats MAW_HOST="0.0.0.0" as an explicit
# opt-in. Without this, a container whose first `maw peers add` failed
# (peer not up yet) would stay on loopback and be unreachable for retry.
export MAW_HOST=0.0.0.0

exec "$@"
