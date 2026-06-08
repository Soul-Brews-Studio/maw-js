#!/usr/bin/env bash
# Strategy B: bun test --isolate for test/isolated/.
#
# Replaces the per-file subprocess loop (Strategy A) with bun's native
# --isolate flag (available since bun 1.3.13). Each test file gets a fresh
# global environment within the same bun process — same isolation guarantee,
# ~3.4x faster (37s vs ~124s for 620 files on m5).
#
# Usage:
#   bash scripts/test-isolated.sh                         # normal run
#   bash scripts/test-isolated.sh --shard 1/4             # deterministic 1-of-4 file shard
#   bash scripts/test-isolated.sh test/isolated/foo.test.ts # targeted run
set -eo pipefail

cd "$(dirname "$0")/.."

export MAW_TEST_MODE=1

BUN_EXTRA_ARGS=(--isolate)
REQUESTED_FILES=()
SHARD_INDEX=""
SHARD_TOTAL=""
EXPECT_SHARD_VALUE=0

parse_shard_spec() {
  local spec="$1"
  local index="${spec%%/*}"
  local total="${spec##*/}"

  if [[ "$spec" != */* ]] || [[ -z "$index" ]] || [[ -z "$total" ]]; then
    echo "error: --shard expects N/T (got: $spec)" >&2
    exit 2
  fi
  if ! [[ "$index" =~ ^[0-9]+$ ]] || ! [[ "$total" =~ ^[0-9]+$ ]]; then
    echo "error: --shard expects numeric N/T (got: $spec)" >&2
    exit 2
  fi
  if [[ "$total" -lt 1 ]] || [[ "$index" -lt 1 ]] || [[ "$index" -gt "$total" ]]; then
    echo "error: --shard requires 1 <= N <= T (got: $spec)" >&2
    exit 2
  fi

  SHARD_INDEX="$index"
  SHARD_TOTAL="$total"
}

for arg in "$@"; do
  if [[ "$EXPECT_SHARD_VALUE" -eq 1 ]]; then
    parse_shard_spec "$arg"
    EXPECT_SHARD_VALUE=0
  elif [[ "$arg" == "--shard" ]]; then
    EXPECT_SHARD_VALUE=1
  elif [[ "$arg" == --shard=* ]]; then
    parse_shard_spec "${arg#--shard=}"
  elif [[ "$arg" == -* ]]; then
    BUN_EXTRA_ARGS+=("$arg")
  elif [[ -d "$arg" ]]; then
    while IFS= read -r file; do
      REQUESTED_FILES+=("$file")
    done < <(find "$arg" -type f -name '*.test.ts' | sort)
  elif [[ -f "$arg" ]]; then
    REQUESTED_FILES+=("$arg")
  else
    echo "error: unknown test path: $arg" >&2
    exit 2
  fi
done

if [[ "$EXPECT_SHARD_VALUE" -eq 1 ]]; then
  echo "error: --shard requires a value" >&2
  exit 2
fi

if [ "${#REQUESTED_FILES[@]}" -gt 0 ]; then
  FILES=("${REQUESTED_FILES[@]}")
else
  FILES=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
  done < <(git ls-files -- 'test/isolated/*.test.ts' | sort)
fi

TOTAL=${#FILES[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "error: no isolated test files matched" >&2
  exit 2
fi

if [[ -n "$SHARD_TOTAL" ]]; then
  SHARD_FILES=()
  file_index=0
  for f in "${FILES[@]}"; do
    slot=$(( (file_index % SHARD_TOTAL) + 1 ))
    if [[ "$slot" -eq "$SHARD_INDEX" ]]; then
      SHARD_FILES+=("$f")
    fi
    file_index=$((file_index + 1))
  done
  FILES=("${SHARD_FILES[@]}")
  TOTAL=${#FILES[@]}

  if [ "$TOTAL" -eq 0 ]; then
    echo "error: shard ${SHARD_INDEX}/${SHARD_TOTAL} matched no isolated test files" >&2
    exit 2
  fi

  echo "=== test-isolated.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected $TOTAL file(s), bun --isolate ==="
else
  echo "=== test-isolated.sh: $TOTAL files, bun --isolate ==="
fi

exec bun test "${FILES[@]}" \
  --path-ignore-patterns '**/agents/**' \
  "${BUN_EXTRA_ARGS[@]}"
