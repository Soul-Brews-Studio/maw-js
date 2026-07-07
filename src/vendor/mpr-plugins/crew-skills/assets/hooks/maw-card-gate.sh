#!/bin/bash
# PreToolUse gate (kobo-174) — deny card-create from a warroom LEAD pane so the
# lead is forced to route card-creation through the conductor (structural forcing
# function > discipline; warroom role-split: dispatch = conductor, not lead).
#
# Two paths gated (MCP-gap lesson): bash `maw task add` AND MCP tool
# mcp__maw__maw_task with action=add. A single PreToolUse hook covers both.
#
# Opt-in: acts ONLY when this oracle ships a `.maw/card-gate.json` config (or the
# legacy settings.json `.mawCardGate` block) — non-adopters are never denied
# (opt-in ไม่กระทบคนอื่น). kobo-200: config moved to .maw/ because CC's settings
# validator rejects the custom top-level key.
#
# Role = tmux per-pane @role marker. The lead is the ORIGIN pane (kobo-178): no
# spawn env can be injected into it, so @role (set by the crew/warroom skill) is
# the only reliable role signal. Detected via:
#   tmux display-message -t "$TMUX_PANE" -p '#{@role}'
# HARDEN (kobo-174): while gating is active, an empty @role / unavailable tmux →
# fail-CLOSED (deny), NEVER fail-open. The crew/warroom skill sets+verifies @role
# at spawn (and re-asserts after respawn), so an empty marker means something
# broke → denying is the safe default.
#
# Override = a conscious --force-lead flag on a bash `maw task add` (NOT env, NOT
# fail-open). The MCP path carries no flag → route through the conductor, or drop
# to bash + --force-lead for a deliberate one-off.
#
# ponytail: substring match on the command. A command that merely quotes "maw
# task add" inside a string could false-deny — rare; re-word or use the flag.

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0   # no jq → can't parse → allow (never block on tooling gap)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# ── 1. is this a card-create call? (two paths) ───────────────────────────────
IS_CREATE=0
FORCE=0
case "$TOOL" in
  Bash)
    CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    case "$CMD" in
      *"maw task add"*|*"maw company task add"*) IS_CREATE=1 ;;
    esac
    case "$CMD" in *"--force-lead"*) FORCE=1 ;; esac
    ;;
  mcp__maw__maw_task)
    ACTION=$(printf '%s' "$INPUT" | jq -r '.tool_input.action // empty' 2>/dev/null)
    [ "$ACTION" = "add" ] && IS_CREATE=1
    ;;
esac
[ "$IS_CREATE" = 1 ] || exit 0

# ── 2. gate config (opt-in) ──────────────────────────────────────────────────
# Config lives in a CC-SAFE file: .maw/card-gate.json (kobo-200). Claude Code's
# settings validator REJECTS unknown top-level keys, so the old settings.json
# `.mawCardGate` block never loaded on a live CC session — the gate silently never
# activated. .maw/ is ours; CC never touches it. Precedence: project → cwd → $HOME.
# The file IS the config object ({leadRole, gatedTools, coordinator}); a wrapped
# {"mawCardGate": {...}} form is also accepted so a copied settings block still works.
CFG_JSON=""
for f in "$CLAUDE_PROJECT_DIR/.maw/card-gate.json" ".maw/card-gate.json" "$HOME/.maw/card-gate.json"; do
  case "$f" in /.maw/*) continue ;; esac   # empty CLAUDE_PROJECT_DIR → skip bogus "/.maw/..."
  [ -f "$f" ] || continue
  CFG_JSON=$(jq -e '.mawCardGate // .' "$f" 2>/dev/null) && break
  CFG_JSON=""
done
# backward-compat: fall back to the pre-kobo-200 settings.json .mawCardGate block
# (works only where CC's validator tolerates it — e.g. a temp HOME / non-CC caller).
if [ -z "$CFG_JSON" ]; then
  for f in "$CLAUDE_PROJECT_DIR/.claude/settings.json" ".claude/settings.json" "$HOME/.claude/settings.json"; do
    case "$f" in /.claude/*) continue ;; esac
    [ -f "$f" ] || continue
    CFG_JSON=$(jq -e '.mawCardGate' "$f" 2>/dev/null) && break
    CFG_JSON=""
  done
fi
[ -n "$CFG_JSON" ] || exit 0   # not adopted → allow

LEAD_ROLE=$(printf '%s' "$CFG_JSON" | jq -r '.leadRole // "lead"' 2>/dev/null)
COORD=$(printf '%s' "$CFG_JSON" | jq -r '.coordinator // "your conductor"' 2>/dev/null)
# card-create must be listed in gatedTools (logical name "maw_task add") to gate.
GATED=$(printf '%s' "$CFG_JSON" | jq -r '(.gatedTools // ["maw_task add"]) | index("maw_task add") // empty' 2>/dev/null)
[ -n "$GATED" ] || exit 0   # card-create not gated → allow

# ── 3. conscious override ────────────────────────────────────────────────────
[ "$FORCE" = 1 ] && exit 0

# ── 4. role detect (fail-CLOSED on empty — HARDEN) ───────────────────────────
ROLE=""
[ -n "$TMUX_PANE" ] && ROLE=$(tmux display-message -t "$TMUX_PANE" -p '#{@role}' 2>/dev/null)
case "$ROLE" in
  *"$LEAD_ROLE"*) ;;   # lead → deny (fall through)
  "")            ;;    # empty/undetectable → fail-CLOSED → deny (fall through)
  *) exit 0 ;;         # known non-lead role (conductor/worker/comm) → allow
esac

REASON="card-create gated for lead → brief the conductor instead: maw hey ${COORD} \"<intent>\". อย่าสร้าง card เป็น lead (warroom role-split — dispatch = conductor's job). Conscious one-off override: append --force-lead to a bash \`maw task add\`."

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
  "$(printf '%s' "$REASON" | jq -Rs .)"
exit 0
