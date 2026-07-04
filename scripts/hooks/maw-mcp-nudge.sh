#!/bin/bash
# PreToolUse(Bash) — force the maw_* MCP tools on the hot path instead of `maw <cmd>`
# via bash (fleet token-audit 2026-07-05: 6954 bash-maw calls, MCP usage 0). The rule
# already lived in CLAUDE.md and was ignored → this is the structural forcing function
# (deny), not another intention. DENY only the subcommands that have a 1:1 MCP surface
# with no bash-only sibling; allow everything else (peek/wake/broadcast/team/quota +
# inbox archive have no MCP equivalent).
#
# Oracle-agnostic: no hardcoded oracle name. Provisioned to
# $HOME/.config/maw/hooks/maw-mcp-nudge.sh by `maw company worklog setup-hooks` + bud-init.
#
# ponytail: substring match on the whole command. A command that merely quotes
# "maw hey" inside a string could false-deny — rare; re-word or use the MCP tool.

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r 'select(.tool_name=="Bash") | .tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

case "$CMD" in
  *"maw inbox archive"*) exit 0 ;;                 # no MCP → allow
  *"maw hey "*|*"maw hey")     TOOL="maw_hey" ;;
  *"maw reply"*)               TOOL="maw_reply" ;;
  *"maw inbox"*)               TOOL="maw_inbox" ;;
  *"maw ls"*)                  TOOL="maw_ls" ;;
  *) exit 0 ;;
esac

REASON="maw hot-path → use the ${TOOL} MCP tool, not bash (structured + skips rtk parse; token-audit). If ${TOOL} isn't loaded yet: ToolSearch \"select:mcp__maw__${TOOL}\" then call it. bash maw is allowed only for peek/wake/broadcast/team/quota + inbox archive."

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
  "$(printf '%s' "$REASON" | jq -Rs .)"
exit 0
