#!/bin/bash
# Claude Code UserPromptSubmit hook → maw worklog.
#   capture:   record the decision/instruction ("Tony→oracle: X")
#   interrupt: if the prior turn ended with "[Request interrupted by user...]",
#              record a kind:interrupt event (the correcting prompt that follows)
#   inject:    read-before-act — push company state + open claims back into context
# Provisioned by `maw watch setup-hooks`.

MAW_PORT="${MAW_PORT:-3456}"
BASE="http://localhost:${MAW_PORT}"
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && ORACLE="unknown"
PROJECT=$(basename "${PWD}" 2>/dev/null)

# capture (fire-and-forget)
if [ -n "$PROMPT" ]; then
  CAP=$(jq -n --arg o "$ORACLE" --arg p "$PROJECT" --arg pr "$PROMPT" \
    '{oracle:$o, event:"UserPromptSubmit", project:$p, host:"local", message:"prompt", data:{prompt:$pr}}')
  curl -s -X POST "$BASE/api/feed" -H 'Content-Type: application/json' -d "$CAP" >/dev/null 2>&1 &
fi

# interrupt detection — the prior turn left the marker as the last transcript entry
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  if tail -n 2 "$TRANSCRIPT" 2>/dev/null | grep -q "Request interrupted by user"; then
    IEV=$(jq -n --arg o "$ORACLE" --arg p "$PROJECT" --arg pr "$PROMPT" \
      '{oracle:$o, event:"Notification", project:$p, host:"local", message:"interrupt", data:{kind:"interrupt", prompt:$pr}}')
    curl -s -X POST "$BASE/api/feed" -H 'Content-Type: application/json' -d "$IEV" >/dev/null 2>&1 &
  fi
fi

# inject (read-before-act) — short timeout so a slow/absent server never blocks the agent
INJECT=$(curl -s --max-time 2 "$BASE/api/worklog?oracle=${ORACLE}" 2>/dev/null | jq -r '.inject // empty')
[ -z "$INJECT" ] && exit 0
jq -n --arg ctx "$INJECT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$ctx}}'
exit 0
