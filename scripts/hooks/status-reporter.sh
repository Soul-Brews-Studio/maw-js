#!/bin/bash
# Claude Code hook → maw agent status reporter
# Posts feed event to maw server for status tracking.
# Used by: SessionStart, Stop hooks in each oracle's .claude/settings.json
#
# Provisioned to $HOME/.config/maw/hooks/status-reporter.sh by bud-init +
# scripts/deploy-hooks.ts (src/core/status-reporter.ts is the runtime source).

MAW_PORT="${MAW_PORT:-3456}"
MAW_URL="http://localhost:${MAW_PORT}/api/feed"

# CC passes a JSON payload on stdin (Stop → includes .transcript_path). Read it up
# front so it's available for turn-ending error detection (kobo-111). Harmless when
# empty (SessionStart / non-CC callers) — nothing downstream requires it.
INPUT=$(cat 2>/dev/null)

HOOK_EVENT="${CLAUDE_HOOK_EVENT:-}"
[ -z "$HOOK_EVENT" ] && exit 0

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && exit 0

SESSION_ID="${CLAUDE_SESSION_ID:-}"
PROJECT=$(basename "${PWD}" 2>/dev/null)

# Pane id ($TMUX_PANE, e.g. "%40") — carried as data.paneId so a Stop event attributes
# the idle state to the right pane (kobo-109, decision B). SAME join key the worklog +
# presence hooks use. No pane INDEX here: idle is a per-pane state signal, never a
# displayed feed line. Empty outside tmux → omit data (paneless Stop = no per-pane signal).
PANEID="${TMUX_PANE:-}"

# Turn-ending API error (kobo-111): on Stop, if the LAST assistant message in the
# transcript is an isApiErrorMessage (CC records API/rate-limit/overload turns this
# way, model:"<synthetic>"), flag the pane as error. Only the LAST assistant message
# — a mid-turn error that later recovered leaves a normal final message, so it is NOT
# flagged. Best-effort: needs jq + the transcript; a missing either → falls back to idle.
# tail -n bounds the read (the terminal message sits at the end); a jq NULL/absent flag
# compares false, so only an explicit true trips it.
ERROR=""
if [ "$HOOK_EVENT" = "Stop" ] && command -v jq >/dev/null 2>&1; then
  TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    LAST_ASSISTANT_ERR=$(tail -n 100 "$TRANSCRIPT" 2>/dev/null \
      | jq -c 'select(.type=="assistant") | .isApiErrorMessage' 2>/dev/null | tail -1)
    [ "$LAST_ASSISTANT_ERR" = "true" ] && ERROR=true
  fi
fi

DATA=""
if [ -n "$PANEID" ]; then
  if [ -n "$ERROR" ]; then
    DATA=",\"data\":{\"paneId\":\"${PANEID}\",\"error\":true}"
  else
    DATA=",\"data\":{\"paneId\":\"${PANEID}\"}"
  fi
fi

curl -s -X POST "$MAW_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"oracle\":\"${ORACLE}\",\"event\":\"${HOOK_EVENT}\",\"sessionId\":\"${SESSION_ID}\",\"project\":\"${PROJECT}\",\"host\":\"$(hostname -s 2>/dev/null || echo local)\",\"message\":\"hook:${HOOK_EVENT}\"${DATA}}" \
  >/dev/null 2>&1 &

exit 0
