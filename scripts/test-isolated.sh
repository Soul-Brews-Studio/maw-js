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
#   bash scripts/test-isolated.sh                         # normal run
#   bash scripts/test-isolated.sh --randomize             # passes --randomize to each file
#   bash scripts/test-isolated.sh --shard 1/4             # deterministic 1-of-4 file shard
#   bash scripts/test-isolated.sh test/isolated/foo.test.ts # fast targeted run, still isolated
#   bash scripts/test-isolated.sh test/isolated/foo.test.ts --randomize
set -eo pipefail

cd "$(dirname "$0")/.."

# #820 — Tell the source guard in src/config/load.ts that we're running tests.
# saveConfig() refuses to write to the real ~/.config/maw/ when this is set,
# preventing fixture leaks into developer config mid-session.
export MAW_TEST_MODE=1

IGNORE_ARGS=(
  --path-ignore-patterns '**/agents/**'
)

BUN_EXTRA_ARGS=()
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

COVERAGE_DIR=""
RUN_ARGS=()
EXPECT_COVERAGE_DIR_VALUE=0
for arg in "${BUN_EXTRA_ARGS[@]}"; do
  if [[ "$EXPECT_COVERAGE_DIR_VALUE" -eq 1 ]]; then
    COVERAGE_DIR="$arg"
    EXPECT_COVERAGE_DIR_VALUE=0
    continue
  fi
  if [[ "$arg" == --coverage-dir=* ]]; then
    COVERAGE_DIR="${arg#--coverage-dir=}"
    continue
  fi
  if [[ "$arg" == "--coverage-dir" ]]; then
    EXPECT_COVERAGE_DIR_VALUE=1
    continue
  fi
  RUN_ARGS+=("$arg")
done
if [[ "$EXPECT_COVERAGE_DIR_VALUE" -eq 1 ]]; then
  echo "error: --coverage-dir requires a value" >&2
  exit 2
fi

append_lcov_manifest() {
  local lcov_path="$1"
  if [[ -n "${MAW_LCOV_MANIFEST:-}" && -f "$lcov_path" ]]; then
    printf '%s\n' "$lcov_path" >> "$MAW_LCOV_MANIFEST"
  fi
}

if [ "${#REQUESTED_FILES[@]}" -gt 0 ]; then
  FILES=("${REQUESTED_FILES[@]}")
else
  FILES=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
  done < <(git ls-files -- 'test/isolated/*.test.ts' | sort)
fi

TOTAL=${#FILES[@]}
PASSED=0
FAILED=0
FAILED_FILES=()

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

  echo "=== test-isolated.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected $TOTAL file(s), one process each ==="
else
  echo "=== test-isolated.sh: $TOTAL files, one process each ==="
fi

VERBOSE="${MAW_TEST_ISOLATED_VERBOSE:-0}"

run_index=0
for f in "${FILES[@]}"; do
  # BSD/macOS mktemp only treats a trailing XXXXXX run as the template.
  # Keep the Xs at the end so repeated isolated coverage runs cannot collide
  # on a literal maw-isolated-test.XXXXXX.log path.
  log_file="$(mktemp "${TMPDIR:-/tmp}/maw-isolated-test-log.XXXXXX")"
  if [[ -n "$COVERAGE_DIR" ]]; then
    run_index=$((run_index + 1))
    run_dir="$COVERAGE_DIR/run-$run_index"
    mkdir -p "$run_dir"
    if bun test "$f" "${IGNORE_ARGS[@]}" "${RUN_ARGS[@]}" --coverage-dir "$run_dir" >"$log_file" 2>&1; then
      append_lcov_manifest "$run_dir/lcov.info"
      PASSED=$((PASSED + 1))
      if [[ "$VERBOSE" == "1" || "$VERBOSE" == "true" ]]; then
        printf -- "--- %s ---\n" "$f"
        cat "$log_file"
      else
        printf '✓ %s\n' "$f"
      fi
    else
      FAILED=$((FAILED + 1))
      FAILED_FILES+=("$f")
      printf -- "--- %s (FAILED) ---\n" "$f"
      cat "$log_file"
    fi
  elif bun test "$f" "${IGNORE_ARGS[@]}" "${RUN_ARGS[@]}" >"$log_file" 2>&1; then
    PASSED=$((PASSED + 1))
    if [[ "$VERBOSE" == "1" || "$VERBOSE" == "true" ]]; then
      printf -- "--- %s ---\n" "$f"
      cat "$log_file"
    else
      printf '✓ %s\n' "$f"
    fi
  else
    FAILED=$((FAILED + 1))
    FAILED_FILES+=("$f")
    printf -- "--- %s (FAILED) ---\n" "$f"
    cat "$log_file"
  fi
  rm -f "$log_file"
done

echo ""
echo "=== summary: $PASSED/$TOTAL files passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
  echo "failed files:"
  for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
  exit 1
fi
