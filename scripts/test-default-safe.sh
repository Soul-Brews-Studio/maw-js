#!/usr/bin/env bash
# test-default-safe.sh — run the default suite without cross-file mock pollution.
#
# WHY:
#   `bun test test/` is not a ship gate by itself because Bun's `mock.module()`
#   is process-global and retroactive. A handful of default-suite files still
#   install module mocks outside `test/isolated/`, which can bleed into later
#   files when they share one Bun process. This script keeps the fast broad
#   sweep for pure/default tests, but peels every default-suite mock-module file
#   into its own Bun subprocess.
#
# RESULT:
#   - one shared Bun process for the ordinary default suite
#   - one Bun process per default-suite file that calls mock.module()
#
# Optional:
#   --shard N/T runs only the Nth deterministic slice of the matched file set.
#   CI uses this to keep the default suite short enough to parallelize while
#   preserving the same per-file mock isolation semantics within each shard.
#
# This is the release/CI-safe replacement for bare `bun run test`.

set -eo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"

export MAW_TEST_MODE=1

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

run_bun_case() {
  local coverage_key="$1"
  local run_cwd="$2"
  shift
  shift

  if [[ -n "$COVERAGE_DIR" ]]; then
    local run_dir="$COVERAGE_DIR/$coverage_key"
    mkdir -p "$run_dir"
    (
      cd "$run_cwd"
      bun test "$@" "${RUN_ARGS[@]}" --coverage-dir "$run_dir"
    )
    append_lcov_manifest "$run_dir/lcov.info"
  else
    (
      cd "$run_cwd"
      bun test "$@" "${RUN_ARGS[@]}"
    )
  fi
}

if [ "${#REQUESTED_FILES[@]}" -gt 0 ]; then
  ALL_TEST_FILES=()
  for f in "${REQUESTED_FILES[@]}"; do
    [[ "$f" == test/helpers/* ]] && continue
    [[ "$f" == test/isolated/* ]] && continue
    [[ "$f" == agents/* || "$f" == *"/agents/"* ]] && continue
    [[ "$f" == test/zz-mock-tmux-smoke.test.ts ]] && continue
    [[ "$f" == test/zz-mock-transport-smoke.test.ts ]] && continue
    ALL_TEST_FILES+=("$f")
  done
else
  ALL_TEST_FILES=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && ALL_TEST_FILES+=("$f")
  done < <(
    git ls-files -- ':(top)test/*.ts' ':(top)test/**/*.ts' |
      while IFS= read -r f; do
        [[ "$f" == test/helpers/* ]] && continue
        [[ "$f" == test/isolated/* ]] && continue
        [[ "$f" == agents/* || "$f" == *"/agents/"* ]] && continue
        [[ "$f" == test/zz-mock-tmux-smoke.test.ts ]] && continue
        [[ "$f" == test/zz-mock-transport-smoke.test.ts ]] && continue
        printf '%s\n' "$f"
      done
  )

  # kobo-499: a green run only proves the FILES IT SAW passed — it says
  # nothing about whether the git-ls-files pathspec above (`:(top)test/*.ts`
  # `:(top)test/**/*.ts`) still matches everything it used to. A narrowed
  # pathspec (a typo, a dropped `**`, an accidental extra exclusion) makes
  # ALL_TEST_FILES silently smaller — every file it DOES contain still runs
  # and passes, so the script exits 0 exactly like a real green run. Comparing
  # ALL_TEST_FILES's own length against itself would prove nothing (it would
  # match ANY narrowing, since both sides come from the same broken glob).
  # This cross-checks the git-ls-files count against an INDEPENDENT recount
  # (`find`, not git's pathspec magic, same exclusion predicates translated
  # 1:1) — a regression in the git pathspec doesn't touch `find`'s logic at
  # all, so the two only disagree when the enumeration actually drifted.
  FIND_RECOUNT_FILES=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && FIND_RECOUNT_FILES+=("$f")
  done < <(
    find test -type f -name '*.ts' |
      sed 's#^\./##' |
      while IFS= read -r f; do
        [[ "$f" == test/helpers/* ]] && continue
        [[ "$f" == test/isolated/* ]] && continue
        [[ "$f" == agents/* || "$f" == *"/agents/"* ]] && continue
        [[ "$f" == test/zz-mock-tmux-smoke.test.ts ]] && continue
        [[ "$f" == test/zz-mock-transport-smoke.test.ts ]] && continue
        printf '%s\n' "$f"
      done |
      sort
  )
  GIT_LS_FILES_SORTED=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && GIT_LS_FILES_SORTED+=("$f")
  done < <(printf '%s\n' "${ALL_TEST_FILES[@]}" | sort)

  if [[ "${GIT_LS_FILES_SORTED[*]}" != "${FIND_RECOUNT_FILES[*]}" ]]; then
    echo "error: test-default-safe.sh: git-ls-files enumeration (${#GIT_LS_FILES_SORTED[@]} file(s)) disagrees with an independent find-based recount (${#FIND_RECOUNT_FILES[@]} file(s)) — the pathspec likely narrowed or widened. Diff:" >&2
    diff <(printf '%s\n' "${GIT_LS_FILES_SORTED[@]}") <(printf '%s\n' "${FIND_RECOUNT_FILES[@]}") >&2 || true
    exit 2
  fi
fi

if [ "${#ALL_TEST_FILES[@]}" -eq 0 ]; then
  echo "error: no default-suite test files matched" >&2
  exit 2
fi

echo "=== test-default-safe.sh: enumerated ${#ALL_TEST_FILES[@]} default-suite test file(s), cross-checked against find ==="

if [[ -n "$SHARD_TOTAL" ]]; then
  SHARD_FILES=()
  file_index=0
  for f in "${ALL_TEST_FILES[@]}"; do
    slot=$(( (file_index % SHARD_TOTAL) + 1 ))
    if [[ "$slot" -eq "$SHARD_INDEX" ]]; then
      SHARD_FILES+=("$f")
    fi
    file_index=$((file_index + 1))
  done
  ALL_TEST_FILES=("${SHARD_FILES[@]}")

  if [ "${#ALL_TEST_FILES[@]}" -eq 0 ]; then
    echo "error: shard ${SHARD_INDEX}/${SHARD_TOTAL} matched no default-suite test files" >&2
    exit 2
  fi

  echo "=== test-default-safe.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected ${#ALL_TEST_FILES[@]} file(s) ==="
fi

MOCK_FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && MOCK_FILES+=("$f")
done < <(
  printf '%s\n' "${ALL_TEST_FILES[@]}" |
    while IFS= read -r f; do
      grep -qE '^[[:space:]]*mock\.module[[:space:]]*\(' "$f" && { printf '%s\n' "$f"; continue; }
      grep -q '@maw-test-isolate' "$f" || continue
      printf '%s\n' "$f"
    done | sort -u
)

SAFE_FILES=()
for f in "${ALL_TEST_FILES[@]}"; do
  is_mock=0
  for mock_file in "${MOCK_FILES[@]}"; do
    if [[ "$mock_file" == "$f" ]]; then
      is_mock=1
      break
    fi
  done
  [[ "$is_mock" -eq 1 ]] && continue
  SAFE_FILES+=("$f")
done

# kobo-476 — `set -e` means any run_bun_case call below that fails exits the
# script immediately, right there. Everything still queued after that point
# (the rest of the shared sweep's siblings don't exist as separate cases, but
# every mock-module file still waiting its turn does) used to vanish with no
# trace: no skip line, no name, no count — silence read as "the rest passed".
# CASE_NAMES is the full run order decided up front; CASE_POS tracks how many
# cases have been (or are being) attempted. One EXIT trap covers every
# ordinary exit and SIGTERM — the shared sweep failing, any mock file failing
# mid-loop, or any future case this script doesn't have yet — instead of
# duplicating the same "what's left" logic at every call site. (SIGKILL can't
# be trapped; that's an OS limit, not a gap in this script.)
CASE_NAMES=("shared sweep (${#SAFE_FILES[@]} file(s))")
for f in "${MOCK_FILES[@]}"; do
  CASE_NAMES+=("mock-isolated: $f")
done
CASE_POS=0
report_unattempted_cases() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 && "$CASE_POS" -lt "${#CASE_NAMES[@]}" ]]; then
    local remaining=$(( ${#CASE_NAMES[@]} - CASE_POS ))
    echo "" >&2
    echo "=== test-default-safe.sh: exited early (code $exit_code) — ${#CASE_NAMES[@]} case(s) total, ${CASE_POS} attempted, ${remaining} NEVER RAN: ===" >&2
    local i
    for (( i = CASE_POS; i < ${#CASE_NAMES[@]}; i++ )); do
      echo "  - ${CASE_NAMES[$i]}" >&2
    done
  fi
}
trap report_unattempted_cases EXIT

echo "=== test-default-safe.sh: shared default sweep ==="
CASE_POS=1
if [[ "${#SAFE_FILES[@]}" -gt 0 ]]; then
  run_bun_case "shared" "$REPO_ROOT" "${SAFE_FILES[@]}"
else
  echo "(skipped: no shared default-suite files matched)"
fi

if [[ "${#MOCK_FILES[@]}" -eq 0 ]]; then
  echo ""
  echo "=== no default-suite mock.module files detected ==="
  echo "=== test-default-safe.sh: completed ${CASE_POS}/${#CASE_NAMES[@]} case(s) — matches enumerated ==="
  exit 0
fi

echo ""
echo "=== test-default-safe.sh: ${#MOCK_FILES[@]} mock-module file(s), one process each ==="
mock_index=0
for f in "${MOCK_FILES[@]}"; do
  printf -- "--- %s ---\n" "$f"
  mock_index=$((mock_index + 1))
  CASE_POS=$((mock_index + 1))
  run_cwd="$REPO_ROOT"
  test_path="$f"
  path_ignore_args=(--path-ignore-patterns '**/agents/**')
  if grep -q '@maw-test-isolate-cwd-neutral' "$f"; then
    run_cwd="${TMPDIR:-/tmp}"
    test_path="$REPO_ROOT/$f"
    # This subprocess intentionally runs outside the repo. In worktrees whose
    # absolute path contains "/agents/" (for example OMX agent worktrees),
    # applying the repo-wide agents ignore to the absolute test filter hides the
    # exact file we are trying to run. The exact file path is already bounded, so
    # no recursive agents ignore is needed here.
    path_ignore_args=()
  fi
  run_bun_case "mock-$mock_index" "$run_cwd" "$test_path" "${path_ignore_args[@]}"
done

# kobo-499: CASE_POS and CASE_NAMES are the SAME variables the loops above
# actually drove (kobo-476's own bookkeeping, not a fresh recount) — this is
# the "declared vs completed, from one source" check: if every case in
# CASE_NAMES was reached (true whenever this line is reached at all, since
# `set -e` + the EXIT trap above would have already reported and exited
# non-zero on any earlier failure), say so explicitly instead of exiting 0
# in silence. A future edit that adds a case to CASE_NAMES without routing it
# through run_bun_case (or skips a mock file inside the loop) would leave
# CASE_POS short of the total and this fails loudly, by construction, not by
# re-deriving a second count that could itself drift from CASE_NAMES.
if [[ "$CASE_POS" -ne "${#CASE_NAMES[@]}" ]]; then
  echo "error: test-default-safe.sh: enumerated ${#CASE_NAMES[@]} case(s), only reached ${CASE_POS} — this should be unreachable if every case above routes through run_bun_case" >&2
  exit 2
fi
echo "=== test-default-safe.sh: completed ${CASE_POS}/${#CASE_NAMES[@]} case(s) — matches enumerated ==="
