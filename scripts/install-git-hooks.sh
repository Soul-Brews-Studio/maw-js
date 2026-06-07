#!/bin/bash
# Install maw-js local development git hooks.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)"
HOOK_SRC="$REPO_ROOT/scripts/hooks/post-commit"
ENV_SRC="$REPO_ROOT/scripts/hooks/maw-hooks.env.example"
HOOK_DST="$REPO_ROOT/.git/hooks/post-commit"
ENV_DST="$REPO_ROOT/.git/maw-hooks.env"

[ -f "$HOOK_SRC" ] || { echo "missing $HOOK_SRC" >&2; exit 1; }
mkdir -p "$(dirname "$HOOK_DST")"

if [ -f "$HOOK_DST" ] && ! cmp -s "$HOOK_SRC" "$HOOK_DST"; then
  backup="$HOOK_DST.backup-$(date +%Y%m%d-%H%M%S)"
  cp "$HOOK_DST" "$backup"
  echo "  ↺ backed up existing hook → $backup"
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "  ✓ installed .git/hooks/post-commit"

if [ ! -f "$ENV_DST" ] && [ -f "$ENV_SRC" ]; then
  cp "$ENV_SRC" "$ENV_DST"
  echo "  ✓ created .git/maw-hooks.env"
else
  echo "  • leaving existing .git/maw-hooks.env unchanged"
fi
