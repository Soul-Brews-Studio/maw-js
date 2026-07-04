#!/bin/bash
# Claude Code statusLine command → maw presence capture (kobo-104).
#
# Reads the CC statusLine JSON on stdin, writes a small presence file keyed by
# the tmux pane id ($TMUX_PANE) to ~/.maw/presence/<pane>.json (atomic write),
# then EITHER delegates to the original statusLine command this one wrapped
# (passed base64-encoded as $1) OR prints maw's own default line.
#
# Best-effort by design: a missing jq, no tmux, or a write error must NEVER
# break the statusline — the script always emits a line and exits 0. Capture is
# independent of output (we write the file whether we delegate or print).
#
# KEY = pane, NOT cwd: crew/warroom workers share one repo (cwd collides) but
# each has a unique tmux pane. $TMUX_PANE (e.g. "%40") is the stable join key.
#
# Provisioned by `maw company worklog setup-hooks`. Source of truth:
# scripts/hooks/maw-statusline.sh (kept byte-identical to the embedded copy by
# worklog.test.ts).

INPUT=$(cat)

# Oracle identity — self-describe the presence file so the read side (the board)
# groups per-oracle by a file field, with NO tmux join at read time (a dead agent
# just stops updating → mtime goes stale). Same resolution the worklog hooks use:
# CLAUDE_AGENT_NAME, else the tmux session name minus its numeric pane prefix.
ORACLE="${CLAUDE_AGENT_NAME:-}"
[ -z "$ORACLE" ] && ORACLE="$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')"
[ -z "$ORACLE" ] && ORACLE="?"

# --- capture (guarded so it can never fault the statusline) ------------------
PANE="${TMUX_PANE:-}"
if command -v jq >/dev/null 2>&1 && [ -n "$PANE" ]; then
  DIR="${MAW_DATA_DIR:-$HOME/.maw}/presence"
  if mkdir -p "$DIR" 2>/dev/null; then
    OUT="$DIR/${PANE}.json"
    TMP="$OUT.$$.tmp"
    TS="$(date +%s)000" # epoch ms (best-effort — seconds precision is enough for staleness)
    # remaining_percentage is null before the first API call + right after /compact
    # (CC hasn't computed it yet) — carry the null through so the UI can show "—".
    # jq paths are tolerant of nesting (context_window.X // top-level X) so a schema
    # tweak on the CC side degrades to null instead of breaking capture.
    if printf '%s' "$INPUT" | jq -c \
        --arg pane "$PANE" --arg ts "$TS" --arg oracle "$ORACLE" '{
          pane: $pane,
          oracle: $oracle,
          ts: ($ts | tonumber),
          model: (.model.display_name // .model.id // null),
          model_id: (.model.id // null),
          remaining_percentage: (.context_window.remaining_percentage // .remaining_percentage // null),
          used_percentage: (.context_window.used_percentage // .used_percentage // null),
          total_input_tokens: (.context_window.total_input_tokens // .total_input_tokens // null),
          context_window_size: (.context_window.context_window_size // .context_window_size // null),
          session_id: (.session_id // null),
          cwd: (.cwd // .workspace.current_dir // null)
        }' > "$TMP" 2>/dev/null; then
      mv -f "$TMP" "$OUT" 2>/dev/null || rm -f "$TMP" 2>/dev/null
    else
      rm -f "$TMP" 2>/dev/null
    fi
  fi
fi

# --- output: delegate to the wrapped statusline, or print maw's default ------
DELEGATE_B64="${1:-}"
if [ -n "$DELEGATE_B64" ]; then
  DELEGATE="$(printf '%s' "$DELEGATE_B64" | base64 -d 2>/dev/null)"
  if [ -n "$DELEGATE" ]; then
    printf '%s' "$INPUT" | eval "$DELEGATE" # emit the original statusline verbatim
    exit 0
  fi
fi

# maw default line — only reached when no prior statusline was wrapped.
if command -v jq >/dev/null 2>&1; then
  MODEL="$(printf '%s' "$INPUT" | jq -r '.model.display_name // .model.id // "?"' 2>/dev/null)"
  PCT="$(printf '%s' "$INPUT" | jq -r '(.context_window.remaining_percentage // .remaining_percentage) as $p | if $p == null then "—" else "\($p | floor)%" end' 2>/dev/null)"
else
  MODEL="?"; PCT="—"
fi
printf '%s · ctx %s · %s' "$MODEL" "$PCT" "$ORACLE"
exit 0
