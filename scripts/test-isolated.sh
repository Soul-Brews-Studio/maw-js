#!/usr/bin/env bash
# Strategy A: per-file subprocess test runner for test/isolated/.
#
# WHY: Bun's `mock.module(...)` is process-global. Running the entire
# test/isolated/ suite in a single `bun test` invocation lets mocks leak
# across files — producing flaky, order-dependent failures that gate CI
# even though each file is green in isolation.
#
# This script runs ONE bun process per test file. Trade-off: slower
# (~bun startup cost × N files) but true isolation. Zero test code
# changes required.
#
# Usage:
#   bash scripts/test-isolated.sh                 # normal run
#   bash scripts/test-isolated.sh --randomize     # passes --randomize to each file
set -eo pipefail

cd "$(dirname "$0")/.."

IGNORE_ARGS=(
  --path-ignore-patterns '**/maw-js/**'
  --path-ignore-patterns '**/agents/**'
)

EXTRA_ARGS=("$@")

FILES=(test/isolated/*.test.ts)
TOTAL=${#FILES[@]}
PASSED=0
FAILED=0
FAILED_FILES=()

echo "=== test-isolated.sh: $TOTAL files, one process each ==="
for f in "${FILES[@]}"; do
  printf -- "--- %s ---\n" "$f"
  if bun test "$f" "${IGNORE_ARGS[@]}" "${EXTRA_ARGS[@]}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_FILES+=("$f")
  fi
done

echo ""
echo "=== summary: $PASSED/$TOTAL files passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
  echo "failed files:"
  for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
  exit 1
fi
