#!/usr/bin/env bash
# preflight.sh — local-build-first sanity check before push (#911)
#
# Why this exists:
#   m5's registry-monorepo migration paid the GitHub Actions tax 7+ times
#   chasing a phantom "binary missing #908 handler" — the bug was a
#   `strings dist/maw | grep monorepo` returning 0 and being mistaken for
#   evidence the symbol was missing. It wasn't. `bun build --minify`
#   renames identifiers to 1-char vars and dead-strips string literals.
#   Grep on a minified Bun bundle is a false-negative trap.
#
#   The fix every time was the same: BUILD LOCALLY, RUN THE BINARY.
#   This script does that in ~10 seconds.
#
# What it does:
#   1. `bun run build`                — fresh local build (silent unless fail)
#   2. (optional) `dist/maw plugin install <name>`  — full install round-trip
#                                                     against live registry
#   3. `dist/maw --version`           — smoke-test the built binary
#   4. `dist/maw plugin --help`       — smoke-test plugin surface
#   5. Print PASS / FAIL with reason
#
# Usage:
#   bash scripts/preflight.sh                       # build + smoke (default)
#   bash scripts/preflight.sh --install shellenv    # also install + verify a plugin
#   bash scripts/preflight.sh --help                # show this header
#
#   bun run preflight                               # via npm script alias
#
# This is OPT-IN, not part of CI. Operators run it before `git push` /
# before opening a PR / before claiming "fixed". It augments CI; it does
# not replace it. CI still runs the authoritative test:all suite.
#
# See: docs/process/local-build-first.md  (#911 post-mortem)

set -euo pipefail

# ─── arg parse ──────────────────────────────────────────────────────────────
INSTALL_PLUGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL_PLUGIN="${2:-}"
      if [[ -z "$INSTALL_PLUGIN" ]]; then
        echo "FAIL: --install requires a plugin name" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "FAIL: unknown arg: $1" >&2
      echo "      try: bash scripts/preflight.sh --help" >&2
      exit 2
      ;;
  esac
done

# ─── colors (auto-disable when not a tty) ──────────────────────────────────
if [[ -t 1 ]]; then
  CYAN=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[90m'; RESET=$'\033[0m'
else
  CYAN=""; GREEN=""; RED=""; DIM=""; RESET=""
fi

step()   { printf '%s==>%s %s\n' "$CYAN" "$RESET" "$*"; }
ok()     { printf '%s✓%s   %s\n' "$GREEN" "$RESET" "$*"; }
fail()   { printf '%sFAIL%s: %s\n' "$RED" "$RESET" "$*" >&2; }
dim()    { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# ─── 1. build ──────────────────────────────────────────────────────────────
step "bun run build"
BUILD_LOG=$(mktemp -t maw-preflight-build-XXXXXX.log)
trap 'rm -f "$BUILD_LOG"' EXIT
if ! bun run build >"$BUILD_LOG" 2>&1; then
  fail "bun run build failed"
  cat "$BUILD_LOG" >&2
  exit 1
fi
ok "build succeeded"

if [[ ! -x "./dist/maw" ]]; then
  fail "./dist/maw not found or not executable after build"
  exit 1
fi

# ─── 2. (optional) install a plugin against the live registry ──────────────
if [[ -n "$INSTALL_PLUGIN" ]]; then
  step "dist/maw plugin install $INSTALL_PLUGIN"
  if ! ./dist/maw plugin install "$INSTALL_PLUGIN"; then
    fail "plugin install $INSTALL_PLUGIN failed against live registry"
    exit 1
  fi
  ok "plugin install round-trip OK ($INSTALL_PLUGIN)"
fi

# ─── 3. smoke: --version ───────────────────────────────────────────────────
step "dist/maw --version"
if ! VERSION_OUT=$(./dist/maw --version 2>&1); then
  fail "dist/maw --version failed: $VERSION_OUT"
  exit 1
fi
dim "    $VERSION_OUT"
ok "version smoke OK"

# ─── 4. smoke: plugin --help ───────────────────────────────────────────────
step "dist/maw plugin --help"
if ! ./dist/maw plugin --help >/dev/null 2>&1; then
  fail "dist/maw plugin --help failed"
  exit 1
fi
ok "plugin surface smoke OK"

# ─── done ──────────────────────────────────────────────────────────────────
echo ""
ok "Local-build OK; safe to push"
dim "    (CI will still run the authoritative test:all suite — this is opt-in augmentation, not a replacement)"
