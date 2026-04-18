#!/bin/bash
# .claude/hooks/check-pr-size.sh
#
# Stop hook — runs when Claude finishes a turn.
# Soft warning (non-blocking) when the working branch's diff exceeds the PR LOC cap.
#
# Cap (per CONTRIBUTING.md): 300 LOC of production code per PR.
# Excludes: test files, fixtures, dist/, lockfiles, vendored deps, generated.
#
# Exit code: always 0 (warnings only).
# Output: warning to stderr if cap exceeded.

set -u

CAP=300

# Must be in a git repo
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Pick a base branch — try origin/main, then main
base="origin/main"
git merge-base HEAD "$base" >/dev/null 2>&1 || base="main"
git merge-base HEAD "$base" >/dev/null 2>&1 || exit 0

# Don't warn when ON main (no PR)
current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$current" = "main" ] || [ "$current" = "alpha" ] && exit 0

# Sum production-code additions, excluding tests/fixtures/generated/docs
loc=$(git diff "$base"...HEAD --numstat 2>/dev/null | awk '
  # Skip test paths
  $3 ~ /(^|\/)test(s|_isolated)?\// { next }
  $3 ~ /(^|\/)__tests__\// { next }
  $3 ~ /(^|\/)fixtures?\// { next }
  $3 ~ /(^|\/)test-helpers\// { next }
  # Skip generated / vendored
  $3 ~ /(^|\/)dist\// { next }
  $3 ~ /(^|\/)build\// { next }
  $3 ~ /(^|\/)node_modules\// { next }
  $3 ~ /(^|\/)\.next\// { next }
  $3 ~ /(^|\/)coverage\// { next }
  $3 ~ /\.snap$/ { next }
  $3 ~ /\.lock$/ { next }
  # Skip docs / config
  $3 ~ /\.(md|json|ya?ml|toml|svg|html|css)$/ { next }
  # Numstat marks binary files with "-" — skip
  $1 == "-" { next }
  { sum += $1 }
  END { print sum+0 }
')

if [ "$loc" -gt "$CAP" ]; then
  printf '\033[33m⚠\033[0m branch %s has %s production LOC vs %s (soft cap %s)\n' "$current" "$loc" "$base" "$CAP" >&2
  printf '   See CONTRIBUTING.md#pr-size — consider splitting (scaffold → logic → integration)\n' >&2
fi

exit 0
