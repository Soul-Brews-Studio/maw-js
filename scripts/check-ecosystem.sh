#!/bin/bash
# check-ecosystem.sh — Verify ecosystem.config.cjs references exist
#
# Catches the exact class of bug from 2026-04-17:
#   refactor renamed src/server.ts → src/core/server.ts
#   but ecosystem.config.cjs still pointed to old path
#   → PM2 crash-loop (20 restarts maw, 542 restarts broker)
#
# Usage:
#   ./scripts/check-ecosystem.sh          # as pre-commit hook or CI step
#   ./scripts/check-ecosystem.sh --fix    # show suggested fixes

set -euo pipefail

CONFIG="ecosystem.config.cjs"

if [ ! -f "$CONFIG" ]; then
  echo "⏭ No $CONFIG found — skipping"
  exit 0
fi

# Extract all script paths from ecosystem config
# Matches: script: 'path/to/file.ts' or script: "path/to/file.ts"
SCRIPTS=$(grep -oP "script:\s*['\"]([^'\"]+)['\"]" "$CONFIG" | grep -oP "['\"][^'\"]+['\"]" | tr -d "'\""  || true)

if [ -z "$SCRIPTS" ]; then
  echo "⚠ No script entries found in $CONFIG"
  exit 0
fi

FAIL=0
CHECKED=0

for s in $SCRIPTS; do
  CHECKED=$((CHECKED + 1))
  if [ -f "$s" ]; then
    echo "  ✓ $s"
  else
    echo "  ✗ $s — FILE NOT FOUND"
    # Try to find where it moved
    BASENAME=$(basename "$s")
    FOUND=$(find src/ -name "$BASENAME" -type f 2>/dev/null | head -3)
    if [ -n "$FOUND" ]; then
      echo "    → Did you mean: $FOUND"
    fi
    FAIL=1
  fi
done

echo ""
if [ $FAIL -eq 0 ]; then
  echo "✓ All $CHECKED ecosystem script paths verified"
else
  echo "✗ ecosystem.config.cjs references missing files — update paths before committing"
  exit 1
fi
