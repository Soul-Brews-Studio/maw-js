#!/bin/bash
# Claude Code PostToolUse hook → maw worklog (significant tool-call activity).
#
# Forwards the tool name + input to maw /api/feed; the maw server applies the
# significance filter (git/gh Bash, Edit/Write/MultiEdit) and persists matching
# calls to worklog.jsonl. The settings.json matcher already narrows to those
# tools, so this script just forwards what it receives.
#
# Provisioned to $HOME/.config/maw/hooks/worklog-tool.sh by `maw watch setup-hooks`.

MAW_PORT="${MAW_PORT:-3456}"
MAW_URL="http://localhost:${MAW_PORT}/api/feed"

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && ORACLE="unknown"
PROJECT=$(basename "${PWD}" 2>/dev/null)
# Pane index distinguishes multiple panes of one oracle (human/coord/worker).
# Empty outside tmux — the server treats a missing pane as back-compat.
PANE=$(tmux display-message -p '#{pane_index}' 2>/dev/null)

PAYLOAD=$(jq -n --arg o "$ORACLE" --arg p "$PROJECT" --arg t "$TOOL" --arg pane "$PANE" --argjson ti "$TOOL_INPUT" \
  '{oracle:$o, event:"PostToolUse", project:$p, host:"local", message:("tool:"+$t), data:({tool_name:$t, tool_input:$ti} + (if $pane != "" then {pane:$pane} else {} end))}')

curl -s -X POST "$MAW_URL" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1 &

exit 0
