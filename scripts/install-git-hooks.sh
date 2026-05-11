#!/bin/bash
# Install maw-js git hooks from scripts/hooks/ into .git/hooks/. (#1194)
#
# Usage: bash scripts/install-git-hooks.sh
#
# Idempotent — re-running replaces hooks with the latest tracked versions
# after backing up any pre-existing copy as .backup-<timestamp>.
# Skips the customization env file (.git/maw-hooks.env) so user edits
# are never clobbered.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

[ -d "$HOOKS_SRC" ] || { echo "❌ $HOOKS_SRC does not exist"; exit 1; }
[ -d "$HOOKS_DST" ] || { echo "❌ $HOOKS_DST does not exist (is this a git repo?)"; exit 1; }

installed=0
for hook_src in "$HOOKS_SRC"/*; do
  name="$(basename "$hook_src")"
  # Examples + READMEs aren't hooks
  case "$name" in
    *.example|README*|*.md) continue ;;
  esac

  hook_dst="$HOOKS_DST/$name"
  if [ -e "$hook_dst" ] && ! cmp -s "$hook_src" "$hook_dst"; then
    cp "$hook_dst" "$hook_dst.backup-$(date +%Y%m%d-%H%M%S)"
    echo "  ↻ backed up existing $name"
  fi
  cp "$hook_src" "$hook_dst"
  chmod +x "$hook_dst"
  echo "  ✓ installed $name"
  installed=$((installed + 1))
done

# Seed the per-user config file from the example, but never overwrite it.
ENV_EXAMPLE="$HOOKS_SRC/maw-hooks.env.example"
ENV_TARGET="$REPO_ROOT/.git/maw-hooks.env"
if [ -f "$ENV_EXAMPLE" ] && [ ! -f "$ENV_TARGET" ]; then
  cp "$ENV_EXAMPLE" "$ENV_TARGET"
  echo "  ✓ seeded $(basename "$ENV_TARGET") from example"
fi

if [ "$installed" -eq 0 ]; then
  echo "ℹ️  no hooks found in $HOOKS_SRC"
  exit 0
fi

echo "✅ Installed $installed hook(s). Edit .git/maw-hooks.env to customize."
