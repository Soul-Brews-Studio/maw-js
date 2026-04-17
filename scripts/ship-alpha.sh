#!/usr/bin/env bash
# ship-alpha.sh — one-command alpha release
#
# Flow:
#   1. Verify clean working tree + on main
#   2. Ensure package.json version matches an unreleased alpha (caller bumps first)
#   3. Tag v<version>
#   4. Push main + tags
#   5. Fast-forward `alpha` branch to the new tag, force-with-lease push
#
# Usage:
#   scripts/ship-alpha.sh                    # use current package.json version
#   scripts/ship-alpha.sh --dry-run          # show what would happen
#
# Does NOT bump the version. Caller is responsible for:
#   - committing the bump
#   - committing any feature/fix commits
#
# This script only handles the tag + push mechanics.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
dim()    { printf '\033[90m%s\033[0m\n' "$*"; }

# 1. Preflight
VERSION=$(grep '"version"' package.json | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
if [[ ! "$VERSION" =~ -alpha\. ]]; then
  red "error: package.json version '$VERSION' is not an alpha. Bump first."
  exit 1
fi
TAG="v$VERSION"

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  red "error: must be on main (currently on $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  red "error: working tree not clean. Commit or stash first."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  red "error: tag $TAG already exists"
  exit 1
fi

bash "$(dirname "$0")/check-mock-boundary.sh" || { red "error: mock-boundary check failed (see #387)"; exit 1; }

cyan "🚢 ship-alpha — $TAG"
dim "  version: $VERSION"
dim "  branch:  $BRANCH ($(git rev-parse --short HEAD))"

if [[ $DRY_RUN -eq 1 ]]; then
  dim "  [dry-run] would tag $TAG"
  dim "  [dry-run] would push main + tags"
  dim "  [dry-run] would fast-forward alpha branch to $TAG and push"
  exit 0
fi

# 2. Tag + push
git tag "$TAG"
cyan "  ⏳ pushing main..."
git push
cyan "  ⏳ pushing tag $TAG..."
git push --tags

# 3. Fast-forward alpha branch
cyan "  ⏳ updating alpha branch..."
git branch -f alpha "$TAG"
git push origin alpha --force-with-lease

green "✓ $TAG shipped"
dim "  main:  $(git rev-parse --short main)"
dim "  alpha: $(git rev-parse --short alpha)"
dim "  tag:   $TAG"
