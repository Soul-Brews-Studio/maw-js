#!/usr/bin/env bash
# scripts/repro-545.sh — verify #545 fix: anchorPane wins over $TMUX_PANE.
#
# WHY: cmdSplit used to split the currently-active pane ($TMUX_PANE), which
# drifted after the first split — so cascade bud/view splits landed in the
# wrong pane (fractal-split #545). The fix adds an explicit `anchorPane`
# option so cmdView can pass the RIGHT source pane instead of leaking
# environment-wins behavior.
#
# Before the fix:  TMUX_PANE is used; passing anchorPane has no effect.
#                  With TMUX_PANE=<bogus>, tmux split-window fails →
#                  cmdSplit throws → this script FAILS.
# After the fix:   anchorPane wins over TMUX_PANE; split lands at the
#                  given pane → main session gains +1 pane → PASS.
#
# Isolation: all tmux calls are routed through a private socket via a PATH
# shim. No state leaks to the user's real tmux server.

set -euo pipefail

cd "$(dirname "$0")/.."

PID=$$
SOCKET="/tmp/repro-545-$PID.sock"
SHIM_DIR="/tmp/repro-545-bin-$PID"
MAIN_SESS="repro-545-main-$PID"
TGT_SESS="repro-545-target-$PID"

cleanup() {
  if [ -x "$SHIM_DIR/tmux" ]; then
    "$SHIM_DIR/tmux" kill-server 2>/dev/null || true
  fi
  rm -rf "$SHIM_DIR" 2>/dev/null || true
  rm -f "$SOCKET" 2>/dev/null || true
}
trap cleanup EXIT

REAL_TMUX=$(command -v tmux)
if [ -z "$REAL_TMUX" ]; then
  echo "FAIL: tmux not installed" >&2
  exit 1
fi

mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/tmux" <<EOF
#!/usr/bin/env bash
# shim: route every tmux invocation through our private socket
exec "$REAL_TMUX" -S "$SOCKET" "\$@"
EOF
chmod +x "$SHIM_DIR/tmux"
export PATH="$SHIM_DIR:$PATH"

tmux new-session -d -s "$MAIN_SESS" "bash"
tmux new-session -d -s "$TGT_SESS" "bash"

BEFORE=$(tmux list-panes -t "$MAIN_SESS" -F '#{pane_id}' | wc -l | tr -d ' ')
MAIN_PANE=$(tmux display-message -t "$MAIN_SESS" -p '#{pane_id}')

# TMUX must be set for cmdSplit's guard to pass; the value itself is not
# used for routing (the PATH shim handles that). TMUX_PANE points at a
# nonexistent pane so the without-fix code path would crash when tmux
# split-window tries to target it.
export TMUX="$SOCKET,0,0"
export TMUX_PANE="%99999"

if ! bun -e "
  const { cmdSplit } = await import('./src/commands/plugins/split/impl');
  await cmdSplit('$TGT_SESS:0', {
    anchorPane: '$MAIN_PANE',
    pct: 50,
    noAttach: true,
  });
" 2>&1; then
  echo "FAIL: cmdSplit threw (likely anchorPane ignored → targeted bogus TMUX_PANE)" >&2
  exit 1
fi

AFTER=$(tmux list-panes -t "$MAIN_SESS" -F '#{pane_id}' | wc -l | tr -d ' ')

if [ "$AFTER" -eq $((BEFORE + 1)) ]; then
  echo "PASS: split honored anchorPane — main session $BEFORE → $AFTER panes"
  exit 0
fi

echo "FAIL: expected $((BEFORE + 1)) panes in $MAIN_SESS, got $AFTER" >&2
tmux list-panes -t "$MAIN_SESS" >&2 || true
exit 1
