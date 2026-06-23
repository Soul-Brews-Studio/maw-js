#!/bin/bash
# Claude Code SessionStart hook → maw worklog: inject latest company state on wake
# (orientation), so an oracle starts already aware of recent activity + open claims.
# Provisioned by `maw watch setup-hooks`.

MAW_PORT="${MAW_PORT:-3456}"
BASE="http://localhost:${MAW_PORT}"
command -v jq >/dev/null 2>&1 || exit 0

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && exit 0

INJECT=$(curl -s --max-time 2 "$BASE/api/worklog?oracle=${ORACLE}" 2>/dev/null | jq -r '.inject // empty')
[ -z "$INJECT" ] && exit 0
jq -n --arg ctx "$INJECT" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ctx}}'
exit 0
