#!/usr/bin/env bash
# test-docker-federation.sh — end-to-end probe round-trip between two maw-js containers.
#
# Expected FAILURE until Soul-Brews-Studio/maw-js#596 ships (server-side /info endpoint).
# Probe client at src/commands/plugins/peers/probe.ts:111 fetches /info, server.ts
# does not register that route — handshake returns HTTP_4XX even between healthy peers.
#
# Contract: docker-fed-0419 team shared contract — docker/compose.yml defines
# services node-a and node-b. Both run `maw serve` and peer each other via `maw peers add`.
# This script verifies `maw peers probe peer` round-trips in both directions.
#
# Usage: ./scripts/test-docker-federation.sh
# Exit  : 0 = both directions PASS; non-zero = any failure (expected until #596)

set -euo pipefail

COMPOSE_FILE="docker/compose.yml"
HEALTHY_TIMEOUT_S=90

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERR: $COMPOSE_FILE not found — run from repo root" >&2
  exit 2
fi

# shellcheck disable=SC2329  # invoked indirectly via trap
cleanup() {
  echo "--- tearing down ---"
  docker compose -f "$COMPOSE_FILE" down -v || true
}
trap cleanup EXIT

dump_logs() {
  echo "--- docker compose logs (tail 80) ---" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=80 >&2 || true
}

echo "--- building + starting federation ---"
docker compose -f "$COMPOSE_FILE" up -d --build

echo "--- waiting for node-a + node-b healthy (timeout ${HEALTHY_TIMEOUT_S}s) ---"
deadline=$(( $(date +%s) + HEALTHY_TIMEOUT_S ))
while :; do
  # jq filter: all service statuses must equal "healthy"
  statuses=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null \
    | jq -r '.Health // "none"' 2>/dev/null || true)
  if [ -n "$statuses" ] && ! echo "$statuses" | grep -qvE '^healthy$'; then
    echo "both services healthy"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERR: services did not reach healthy within ${HEALTHY_TIMEOUT_S}s" >&2
    dump_logs
    exit 3
  fi
  sleep 2
done

probe() {
  local from="$1"
  local to_name="$2"
  local rc=0
  local out
  out=$(docker compose -f "$COMPOSE_FILE" exec -T "$from" maw peers probe "$to_name" 2>&1) || rc=$?
  printf '%s\n' "$out"
  return "$rc"
}

echo "--- probe a → b ---"
a_out=$(probe node-a peer || true)
a_rc=$?
echo "$a_out"

echo "--- probe b → a ---"
b_out=$(probe node-b peer || true)
b_rc=$?
echo "$b_out"

verdict() {
  local rc="$1"
  local out="$2"
  if [ "$rc" -eq 0 ] && ! echo "$out" | grep -q "handshake failed"; then
    echo "PASS"
  else
    echo "FAIL"
  fi
}

a_verdict=$(verdict "$a_rc" "$a_out")
b_verdict=$(verdict "$b_rc" "$b_out")

# Cheap hint extractor — first line containing "HTTP" or "error" (safe fallback "-")
hint() {
  echo "$1" | grep -oE '(HTTP[_A-Z0-9]*|ENOTFOUND|ECONNREFUSED|EAI_[A-Z]+|handshake failed[^"]*)' \
    | head -1 || true
}

a_hint=$(hint "$a_out")
b_hint=$(hint "$b_out")

cat <<REPORT

## Docker federation probe result
- a → b: ${a_verdict}, code: ${a_rc}, hint: ${a_hint:--}
- b → a: ${b_verdict}, code: ${b_rc}, hint: ${b_hint:--}

REPORT

if [ "$a_verdict" = "PASS" ] && [ "$b_verdict" = "PASS" ]; then
  echo "OK: both directions passed"
  exit 0
fi

echo "FAIL: at least one direction failed (expected until #596 lands)" >&2
dump_logs
exit 1
