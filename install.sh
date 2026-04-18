#!/bin/bash
# maw-js installer — install maw CLI from any branch or tag via bun
#
# Usage:
#   curl -fsSL .../install.sh | bash                       # latest release (bun add -g)
#   curl -fsSL .../install.sh | bash -s -- --branch alpha  # from branch
#   curl -fsSL .../install.sh | bash -s -- --tag v1.7.2    # from tag
#   curl -fsSL .../install.sh | bash -s -- alpha           # shorthand
#   curl -fsSL .../install.sh | bash -s -- --bunx          # bunx wrapper (no global install)
#
# Two install modes:
#   default     bun add -g   — persistent binary at ~/.bun/bin/maw
#   --bunx      wrapper      — creates ~/.bun/bin/maw that delegates to bunx (always fetches latest)
#
# Also works without install.sh:
#   bun add -g github:Soul-Brews-Studio/maw-js#alpha       # persistent
#   bunx --bun github:Soul-Brews-Studio/maw-js#alpha ...   # zero-install, one-shot
#
# Env overrides:
#   MAW_REF=alpha           Same as --branch alpha
#   MAW_SKIP_PM2=1          Skip PM2 setup hints
#   MAW_GHQ=1               Also clone repo via ghq (for development)

set -e

REPO="Soul-Brews-Studio/maw-js"
REF=""
REF_TYPE=""
USE_BUNX=0
FORCE=0

# ── Parse args ─────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --branch|-b)
      REF="$2"; REF_TYPE="branch"; shift 2 ;;
    --tag|-t)
      REF="$2"; REF_TYPE="tag"; shift 2 ;;
    --bunx)
      USE_BUNX=1; shift ;;
    --ghq)
      MAW_GHQ=1; shift ;;
    --skip-pm2)
      MAW_SKIP_PM2=1; shift ;;
    --force|-f)
      FORCE=1; shift ;;
    --help|-h)
      echo "Usage: install.sh [--branch <name>] [--tag <version>] [--bunx] [--ghq] [--skip-pm2] [--force]"
      echo ""
      echo "  --branch, -b <name>    Install from branch (e.g. alpha, main)"
      echo "  --tag, -t <version>    Install from tag (e.g. v1.7.2, v1.8.0)"
      echo "  --bunx                 Create bunx wrapper instead of global install"
      echo "  --ghq                  Also clone repo via ghq"
      echo "  --skip-pm2             Skip PM2 setup hints"
      echo "  --force, -f            Reinstall even if already at desired ref"
      echo ""
      echo "  No flag = latest release via bun add -g."
      echo "  Shorthand: install.sh alpha = --branch alpha"
      echo "  Shorthand: install.sh v1.7.2 = --tag v1.7.2"
      echo ""
      echo "Also works without this script:"
      echo "  bun add -g github:Soul-Brews-Studio/maw-js#alpha    # persistent"
      echo "  bunx --bun github:Soul-Brews-Studio/maw-js#alpha .. # zero-install"
      exit 0 ;;
    -*)
      echo "Unknown flag: $1"; exit 1 ;;
    *)
      if echo "$1" | grep -q "^v[0-9]"; then
        REF="$1"; REF_TYPE="tag"
      else
        REF="$1"; REF_TYPE="branch"
      fi
      shift ;;
  esac
done

# Env fallback
if [ -z "$REF" ] && [ -n "$MAW_REF" ]; then
  REF="$MAW_REF"
  if echo "$REF" | grep -q "^v[0-9]"; then
    REF_TYPE="tag"
  else
    REF_TYPE="branch"
  fi
fi

# Default: latest release tag from GitHub API
if [ -z "$REF" ]; then
  REF=$(curl -s https://api.github.com/repos/${REPO}/releases/latest 2>/dev/null | grep '"tag_name"' | cut -d'"' -f4)
  REF_TYPE="tag"
  if [ -z "$REF" ]; then
    REF="alpha"
    REF_TYPE="branch"
    echo "  ⚠️  Could not fetch latest release, falling back to alpha"
  fi
fi

echo ""
echo "  🍺 maw-js installer"
echo "  ─────────────────────"
echo "  ${REF_TYPE}: ${REF}"
echo ""

# ── Check bun ───────────────────────────────────────────────

if ! command -v bun >/dev/null 2>&1; then
  echo "📦 Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "  bun: $(bun --version)"

# ── Install maw via bun global ──────────────────────────────

PKG="github:${REPO}#${REF}"

if [ "$USE_BUNX" = "1" ]; then
  # ── bunx wrapper mode ──────────────────────────────────────
  echo ""
  echo "📦 Creating bunx wrapper for ${PKG}..."

  BIN_DIR="$HOME/.bun/bin"
  mkdir -p "$BIN_DIR"

  cat > "$BIN_DIR/maw" <<WRAPPER
#!/bin/bash
# maw — bunx wrapper (${REF_TYPE}: ${REF})
# Delegates to bunx, always fetches latest from the ref.
# Reinstall: curl -fsSL .../install.sh | bash -s -- --bunx ${REF}
# Upgrade to persistent: bun add -g ${PKG}
exec bunx --bun ${PKG} "\$@"
WRAPPER
  chmod +x "$BIN_DIR/maw"

  echo "  ✅ Wrapper created at ${BIN_DIR}/maw"
  echo "  Mode: bunx (fetches latest on every run)"
else
  # ── bun add -g mode (persistent) ───────────────────────────
  #
  # Fast-path: skip reinstall if maw is already at the desired tag and the
  # user did not pass --force. Reason: `bun add -g <github>` mutates the
  # global node_modules in place over a multi-second window, during which
  # `~/.bun/bin/maw` points at a half-extracted target. Concurrent `maw`
  # invocations during that window fail with "No such file or directory"
  # (#507 regression — observed live 2026-04-18 mid-session).
  if [ "$FORCE" != "1" ] && [ "$REF_TYPE" = "tag" ] && command -v maw >/dev/null 2>&1; then
    CURRENT=$(maw --version 2>/dev/null | head -1 | awk '{print $NF}')
    if [ -n "$CURRENT" ] && [ "$CURRENT" = "$REF" ]; then
      echo ""
      echo "  ✅ maw already at $CURRENT — skipping reinstall (use --force to override)"
      echo ""
      echo "  🍺 Done!"
      exit 0
    fi
  fi

  echo ""
  echo "📦 Installing maw from ${PKG}..."
  echo "  ⚠️  Don't run maw commands for the next ~10s — bun re-extracts the global package."
  bun add -g "${PKG}"

  echo "  Mode: persistent (binary linked)"
fi

# Verify
if command -v maw >/dev/null 2>&1; then
  echo ""
  echo "  ✅ $(maw --version 2>/dev/null || echo 'maw installed')"
else
  if [ -f "$HOME/.bun/bin/maw" ]; then
    echo ""
    echo "  ✅ maw installed at ~/.bun/bin/maw"
    echo "  ⚠️  Add to PATH: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  else
    echo "  ❌ maw binary not found after install"
    exit 1
  fi
fi

# ── Optional: clone repo via ghq ────────────────────────────

if [ "${MAW_GHQ}" = "1" ]; then
  if command -v ghq >/dev/null 2>&1; then
    echo ""
    echo "📂 Cloning repo via ghq..."
    ghq get -u "github.com/${REPO}"
    GHQ_PATH="$(ghq root)/github.com/${REPO}"
    cd "$GHQ_PATH"
    if [ "$REF_TYPE" = "branch" ]; then
      git checkout "${REF}" 2>/dev/null || true
    fi
    bun install
    echo "  ✅ Repo at ${GHQ_PATH}"
  else
    echo "  ⚠️  ghq not found — skipping repo clone"
  fi
fi

# ── Optional: PM2 hints ────────────────────────────────────

if [ "${MAW_SKIP_PM2}" != "1" ] && command -v pm2 >/dev/null 2>&1; then
  echo ""
  echo "🔧 PM2 detected. To start maw server:"
  echo "  pm2 start maw --interpreter bun -- serve"
fi

# ── Done ────────────────────────────────────────────────────

echo ""
echo "  🍺 Done!"
echo ""
echo "  Quick start:"
echo "    maw oracle scan        # discover oracles"
echo "    maw oracle fleet       # see the constellation"
echo "    maw wake <oracle>      # start an oracle"
echo "    maw peek               # see all panes"
echo ""
echo "  Update:"
echo "    bun add -g ${PKG}"
echo ""
