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
#   bash scripts/test-isolated.sh                    # normal run
#   bash scripts/test-isolated.sh --randomize        # passes --randomize to each file
#   bash scripts/test-isolated.sh --shard 3/8        # process modulo-shard: files 3, 11, 19, ...
#   bash scripts/test-isolated.sh --shard=3/8        # same, = form (#1257)
#
# Sharding: --shard N/M splits the file list into M groups and runs group N
# (1-indexed). Each subprocess is already independent (one bun process per
# file), so sharded runs are fully parallelizable across CI runners.
set -eo pipefail

cd "$(dirname "$0")/.."

# #820 — Tell the source guard in src/config/load.ts that we're running tests.
# saveConfig() refuses to write to the real ~/.config/maw/ when this is set,
# preventing fixture leaks into developer config mid-session.
export MAW_TEST_MODE=1

IGNORE_ARGS=(
  --path-ignore-patterns '**/agents/**'
)

# Parse --shard N/M or --shard=N/M out of the arg list; everything else
# passes through to `bun test` (e.g. --randomize). (#1257)
SHARD_N=""
SHARD_M=""
EXTRA_ARGS=()
i=0
args=("$@")
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --shard=*)
      spec="${arg#--shard=}"
      SHARD_N="${spec%/*}"
      SHARD_M="${spec#*/}"
      ;;
    --shard)
      i=$((i + 1))
      spec="${args[$i]:-}"
      SHARD_N="${spec%/*}"
      SHARD_M="${spec#*/}"
      ;;
    *)
      EXTRA_ARGS+=("$arg")
      ;;
  esac
  i=$((i + 1))
done

if [ -n "$SHARD_N" ] && [ -n "$SHARD_M" ]; then
  if ! [[ "$SHARD_N" =~ ^[0-9]+$ ]] || ! [[ "$SHARD_M" =~ ^[0-9]+$ ]]; then
    echo "ERR: --shard wants N/M with integers (got '$SHARD_N/$SHARD_M')" >&2
    exit 2
  fi
  if [ "$SHARD_N" -lt 1 ] || [ "$SHARD_N" -gt "$SHARD_M" ]; then
    echo "ERR: --shard N must be in 1..M (got '$SHARD_N/$SHARD_M')" >&2
    exit 2
  fi
fi

ALL_FILES=(test/isolated/*.test.ts)
if [ -n "$SHARD_N" ] && [ -n "$SHARD_M" ]; then
  FILES=()
  for ((i = SHARD_N - 1; i < ${#ALL_FILES[@]}; i += SHARD_M)); do
    FILES+=("${ALL_FILES[$i]}")
  done
  SHARD_LABEL=" (shard $SHARD_N/$SHARD_M)"
else
  FILES=("${ALL_FILES[@]}")
  SHARD_LABEL=""
fi
TOTAL=${#FILES[@]}
PASSED=0
FAILED=0
FAILED_FILES=()

echo "=== test-isolated.sh: $TOTAL files, one process each${SHARD_LABEL} ==="
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
