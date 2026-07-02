#!/usr/bin/env bash
# Isolation: one subprocess per test file (`bun test <file>`), with --isolate
# passed as defense-in-depth.
#
# History: Strategy B tried running a whole shard in ONE `bun test --isolate`
# process for speed (~3.4x). But --isolate gives fresh globals per file WITHOUT
# preventing mock.module() registrations from bleeding across files in the same
# process — 140 isolated tests mock the SDK, so the combined run was order-
# fragile (adding/removing a file reshuffled shards and could link-break a later
# file's `import { X } from "maw-js/sdk"`). Both the shard and full-suite paths
# now use the per-file subprocess loop (Strategy A): a process boundary is the
# only order-independent isolation. Slower, but deterministically green.
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

  # Fall through to the per-file subprocess loop below — do NOT run the whole
  # shard in one `bun test --isolate` process. `--isolate` gives fresh globals
  # per file but does NOT prevent `mock.module(...)` registrations from bleeding
  # across files in the same process: a partial `mock.module("maw-js/sdk", ...)`
  # in one file makes a later file's top-level `import { X } from "maw-js/sdk"`
  # fail to link ("Export 'X' not found", unhandled error between tests). 140
  # isolated tests mock the SDK, so the combined run was order-fragile: adding or
  # removing any test file reshuffled shards and could co-locate a leaker with a
  # victim. A true subprocess per file is the only order-independent isolation.
  echo "=== test-isolated.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected $TOTAL file(s) ==="
fi

PER_FILE_TIMEOUT="${MAW_TEST_ISOLATED_FILE_TIMEOUT:-60}"

# Portable timeout: GNU `timeout` (Linux/CI), `gtimeout` (macOS coreutils), or
# run without a timeout if neither is present (local dev on stock macOS).
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi

echo "=== test-isolated.sh: $TOTAL files, per-file subprocess (--isolate)${TIMEOUT_BIN:+, ${PER_FILE_TIMEOUT}s timeout} ==="

failures=0
for file in "${FILES[@]}"; do
  echo "--- $file ---"
  # gateway-proxy compiles Rust: its beforeAll runs a cold `cargo build
  # --release` of ~92 crates (axum/hyper/tokio) and budgets 120s for it
  # (BUILD_TIMEOUT_MS). The default 60s guard SIGKILLs it mid-build (exit 124)
  # on CI, which has no cargo cache and rebuilds cold every run. Give this one
  # file room for the build + tests. ponytail: cold rust build, not a hang.
  file_timeout="$PER_FILE_TIMEOUT"
  case "$file" in
    */gateway-proxy.test.ts) file_timeout="${MAW_TEST_GATEWAY_FILE_TIMEOUT:-240}" ;;
  esac
  set +e
  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" "$file_timeout" bun test "$file" \
      --path-ignore-patterns '**/agents/**' \
      "${BUN_EXTRA_ARGS[@]}"
  else
    bun test "$file" \
      --path-ignore-patterns '**/agents/**' \
      "${BUN_EXTRA_ARGS[@]}"
  fi
  status=$?
  set -e
  if [[ "$status" -eq 124 ]]; then
    echo "error: isolated test timed out after ${file_timeout}s: $file" >&2
    failures=$((failures + 1))
  elif [[ "$status" -ne 0 ]]; then
    echo "error: isolated test failed with exit $status: $file" >&2
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  echo "=== test-isolated.sh: $failures file(s) failed or timed out ===" >&2
  exit 1
fi

echo "=== test-isolated.sh: all $TOTAL file(s) passed ==="
