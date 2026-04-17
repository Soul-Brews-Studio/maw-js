#!/usr/bin/env bash
# check-mock-export-sync.sh — verify mock helpers re-export every symbol
# from their target src module (#435).
#
# Why: mock.module writes to a process-global registry. If the real module
# gains an export (e.g. #431 added HostExecError to src/core/transport/ssh.ts)
# and the canonical mock isn't updated, later tests importing the real module
# get the polluted mock and fail with "Export named X not found".
#
# Opt-in via JSDoc tag in each mock file:
#   @target-module src/core/transport/ssh.ts
#
# Mocks without the tag are skipped. For each tagged mock:
#   1. Read the target src path from the @target-module tag
#   2. Extract named runtime exports from the target (class/function/const/
#      let/var + `export { a, b } from "..."` re-exports)
#   3. For each name, verify it appears in the mock file
#   4. Exit nonzero with a file + missing-exports list if any drift
#
# Exit 0 on clean tree, exit 1 on any mismatch.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fails=0

extract_src_exports() {
  local src="$1"
  {
    # Direct declarations: export [async] class|function|const|let|var X
    (grep -oE '^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?(class|function|const|let|var)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' "$src" 2>/dev/null || true) \
      | awk '{print $NF}'
    # Brace-style re-exports: export { a, b as c } [from "..."]
    # Skip `export type {` — runtime mocks don't need type-only symbols
    (grep -E '^[[:space:]]*export[[:space:]]*\{' "$src" 2>/dev/null || true) \
      | sed -E 's/.*export[[:space:]]*\{([^}]*)\}.*/\1/' \
      | tr ',' '\n' \
      | sed -E 's#^[[:space:]]+##; s#[[:space:]]+$##; s#.* as ##' \
      | (grep -E '^[A-Za-z_][A-Za-z0-9_]*$' || true)
  } | sort -u
}

while IFS= read -r mock; do
  [[ -z "$mock" ]] && continue
  target=$(grep -oE '@target-module[[:space:]]+\S+' "$mock" 2>/dev/null | awk '{print $2}' | head -1 || true)
  [[ -z "$target" ]] && continue
  if [[ ! -f "$target" ]]; then
    echo "$mock: @target-module points to missing file: $target" >&2
    fails=$((fails + 1))
    continue
  fi
  missing=()
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    grep -qE "\b${name}\b" "$mock" || missing+=("$name")
  done < <(extract_src_exports "$target")
  if (( ${#missing[@]} > 0 )); then
    echo "$mock (target: $target) missing: ${missing[*]}" >&2
    fails=$((fails + 1))
  fi
done < <(git ls-files -- 'test/helpers/mock-*.ts')

if (( fails > 0 )); then
  echo "" >&2
  echo "✗ mock-export-sync violation (#435): $fails mock(s) drifted from target src" >&2
  echo "  Fix: add the missing export to the mock helper, or remove the" >&2
  echo "       @target-module tag if the mapping no longer applies." >&2
  exit 1
fi
exit 0
