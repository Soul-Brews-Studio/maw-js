#!/bin/bash
# Claude Code hook → maw agent status reporter
# Posts feed event to maw server for status tracking.
# Used by: SessionStart, Stop hooks in each oracle's .claude/settings.json
#
# Provisioned to $HOME/.config/maw/hooks/status-reporter.sh by bud-init +
# scripts/deploy-hooks.ts (src/core/status-reporter.ts is the runtime source).

MAW_PORT="${MAW_PORT:-3456}"
MAW_URL="http://localhost:${MAW_PORT}/api/feed"

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
DATA=""
[ -n "$PANEID" ] && DATA=",\"data\":{\"paneId\":\"${PANEID}\"}"

curl -s -X POST "$MAW_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"oracle\":\"${ORACLE}\",\"event\":\"${HOOK_EVENT}\",\"sessionId\":\"${SESSION_ID}\",\"project\":\"${PROJECT}\",\"host\":\"$(hostname -s 2>/dev/null || echo local)\",\"message\":\"hook:${HOOK_EVENT}\"${DATA}}" \
  >/dev/null 2>&1 &

exit 0
