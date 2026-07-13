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

# Company self-describe (kobo-267) — the spawn (crew §0 / warroom) sets
# MAW_ROOM_COMPANY once per pane; we stamp it verbatim so the presence read side
# can scope by company with NO tmux/panes.env join. Read from the pane's own env
# each tick (mv -f keeps the field) — never derive per-tick, a pane's company is
# fixed at spawn. Empty when a pane wasn't spawned with a company → null (that
# pane is excluded from a ?company= query, included host-wide).
COMPANY="${MAW_ROOM_COMPANY:-}"

PANE="${TMUX_PANE:-}"

# --- presence badge (kobo-297): glanceable online/away, persistent every tick -----
# A pane is "away" when its newest away/back worklog marker is `away` (maw presence
# away/back, sticky kobo-287). Read it cheaply read-only: grep THIS pane's markers,
# newest wins. Best-effort — no company / no file / no marker → online, and any error
# is swallowed so the badge can never fault the statusline. Purely display: no presence
# logic touched. seat-resume.sh flips away→online at boot; this shows the state at all times.
BADGE=$'\x1b[32m● online\x1b[0m'
if [ -n "$PANE" ] && [ -n "$COMPANY" ]; then
  WL="${MAW_DATA_DIR:-$HOME/.maw}/companies/${COMPANY}/worklog.jsonl"
  if [ -f "$WL" ]; then
    LAST="$(grep -F "\"paneId\":\"$PANE\"" "$WL" 2>/dev/null | grep -oE '"kind":"(away|back)"' | tail -1)"
    [ "$LAST" = '"kind":"away"' ] && BADGE=$'\x1b[33m○ away\x1b[0m'
  fi
fi

# --- capture (guarded so it can never fault the statusline) ------------------
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
        --arg pane "$PANE" --arg ts "$TS" --arg oracle "$ORACLE" --arg company "$COMPANY" '{
          pane: $pane,
          oracle: $oracle,
          company: (if $company == "" then null else $company end),
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
    printf '%s ' "$BADGE" # kobo-297 — prefix the presence badge, then the user's line verbatim
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
printf '%s · %s · ctx %s · %s' "$BADGE" "$MODEL" "$PCT" "$ORACLE" # kobo-297 — badge first
exit 0
