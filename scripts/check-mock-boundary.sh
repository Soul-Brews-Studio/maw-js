#!/usr/bin/env bash
# check-mock-boundary.sh — prevent mock.module cross-pollution (#387)
#
# Rule: mock.module() is only permitted in:
#   - test/isolated/   (runs as its own subprocess via `bun test test/isolated/`)
#   - test/helpers/    (mock definitions — imported, not executed directly)
# Reason: Bun's mock.module is PROCESS-GLOBAL. Two files that both call
#   mock.module('foo', ...) in the same process race and pollute each other.
#   Isolating them into separate `bun test` invocations is what keeps
#   `bun run test:all` green.
#
# Modes:
#   Grandfathered files listed in scripts/mock-boundary-allowlist.txt are skipped.
#   Per-line escape hatch: a line containing `mock-boundary-ok:` is skipped
#   (use as a same-line or preceding-line comment with a short reason).
#
# Exit 0 on clean tree, exit 1 on any unauthorized mock.module call.
# Fully implements decision (e)+(d) from issue #387.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ALLOW="scripts/mock-boundary-allowlist.txt"
fails=0

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" == test/isolated/* || "$f" == test/helpers/* ]] && continue
  [[ -f "$ALLOW" ]] && grep -qxF "$f" "$ALLOW" && continue
  matches=$(grep -nE '^[[:space:]]*mock\.module[[:space:]]*\(' "$f" 2>/dev/null | grep -v 'mock-boundary-ok:' || true)
  if [[ -n "$matches" ]]; then
    echo "$matches" | sed "s|^|$f:|" >&2
    fails=$((fails + 1))
  fi
done < <(git ls-files -- 'test/*.ts' 'test/**/*.ts')

if (( fails > 0 )); then
  echo "" >&2
  echo "✗ mock-boundary violation (#387): $fails file(s) call mock.module outside test/isolated/ or test/helpers/" >&2
  echo "  Fix: move the test into test/isolated/, OR add '// mock-boundary-ok: <reason>' on the offending line." >&2
  echo "  Background: see test/README.md" >&2
  exit 1
fi
exit 0
