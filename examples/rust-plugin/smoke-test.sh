#!/usr/bin/env bash
#
# smoke-test.sh — end-to-end proof of the maw engine-plugin IPC contract (#2566).
#
# Boots an ISOLATED `maw serve` on a throwaway port + state dir (never touches
# the real fleet), starts the rust-echo plugin, asserts the proxied echo
# round-trip + the gateway-injected headers, then tears everything down.
#
# Exit 0 = proof passed.  Exit 2 = skipped (toolchain missing).  Exit 1 = failed.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-39466}"

command -v cargo >/dev/null 2>&1 || { echo "SKIP: cargo not found"; exit 2; }
command -v bun   >/dev/null 2>&1 || { echo "SKIP: bun not found";   exit 2; }

echo "== building rust-echo"
( cd "$HERE" && cargo build --release ) || { echo "FAIL: cargo build"; exit 1; }
PLUGIN="$HERE/target/release/rust-echo"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maw-2566.XXXXXX")"
mkdir -p "$ROOT/state" "$ROOT/config" "$ROOT/home"
printf '{"bind":"127.0.0.1","port":%s,"node":"smoke2566"}\n' "$PORT" > "$ROOT/config/maw.config.json"
export MAW_NO_SCOUT=1
export MAW_STATE_DIR="$ROOT/state" MAW_CONFIG_DIR="$ROOT/config" MAW_HOME="$ROOT/home"

SERVE_PID="" ECHO_PID=""
cleanup() { [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null; [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null; }
trap cleanup EXIT

echo "== starting isolated maw serve on 127.0.0.1:$PORT"
( cd "$REPO" && bun run src/cli.ts serve "$PORT" ) >"$ROOT/serve.log" 2>&1 &
SERVE_PID=$!
up=0
for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$PORT/api/_engine/registrations" >/dev/null 2>&1 && { up=1; break; }
  sleep 0.3
done
[ "$up" = 1 ] || { echo "FAIL: serve did not come up"; tail -20 "$ROOT/serve.log"; exit 1; }

echo "== starting rust-echo plugin"
"$PLUGIN" "$PORT" >"$ROOT/echo.log" 2>&1 &
ECHO_PID=$!
reg=0
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/api/_engine/registrations" 2>/dev/null | grep -q '"plugin":"rust-echo"' && { reg=1; break; }
  sleep 0.2
done
[ "$reg" = 1 ] || { echo "FAIL: plugin did not register"; cat "$ROOT/echo.log"; exit 1; }

echo "== proxied POST /api/rust-echo/hi"
body="$(curl -fsS "http://127.0.0.1:$PORT/api/rust-echo/hi" -H 'X-Demo: 1' -d 'pong')"
hdrs="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$PORT/api/rust-echo/hi" -d 'pong')"
echo "   body: $body"

fail=0
echo "$body" | grep -q '"method":"POST"'                    || { echo "MISS: method POST";        fail=1; }
echo "$body" | grep -q '"path":"/hi"'                       || { echo "MISS: path /hi (stripped)"; fail=1; }
echo "$body" | grep -q '"body":"pong"'                      || { echo "MISS: body pong";          fail=1; }
echo "$body" | grep -q '"x-maw-engine-plugin":"rust-echo"'  || { echo "MISS: injected plugin hdr"; fail=1; }
echo "$body" | grep -q '"x-forwarded-prefix":"/api/rust-echo"' || { echo "MISS: injected prefix hdr"; fail=1; }
echo "$hdrs" | grep -qi '^x-maw-engine-plugin: rust-echo'   || { echo "MISS: response plugin hdr";  fail=1; }

if [ "$fail" = 0 ]; then echo "== PASS: gateway IPC contract verified"; exit 0; fi
echo "== FAIL"; exit 1
