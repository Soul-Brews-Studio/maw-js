#!/usr/bin/env bash
# Auto-seat: on /clear (post-toilet), re-orient THIS warroom pane by injecting
# its role-specific resume file as SessionStart additionalContext — the cleared
# session wakes up already seated, no manual /seat needed.
# Role-aware: reads tmux @role (per-pane marker, same signal as the card-gate
# hook) → picks lead-resume / conductor / comm / worker state. eq3 local
# prove-first; bake to crew-skills fleet-wide if it holds.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WR="$ROOT/ψ/active/warroom"
[ -d "$WR" ] || exit 0   # not a warroom repo → nothing to seat.

# Per-pane role (empty if unset / not in tmux) — same marker the gate uses.
ROLE="$(tmux display-message -t "${TMUX_PANE:-}" -p '#{@role}' 2>/dev/null || true)"

case "$ROLE" in
  *lead*)      FILE="$WR/lead-resume.md" ;;
  *[Cc]onduct*) FILE="$WR/conductor.md" ;;
  *comm*)      FILE="$WR/comm.md" ;;
  *worker*)    FILE="$WR/worker.md" ;;
  *)           exit 0 ;;   # unknown/empty role → don't guess, stay silent.
esac

[ -f "$FILE" ] || exit 0

# Clear away-flag so hey delivers again (mirrors /seat step 2.5, silent).
maw presence back >/dev/null 2>&1 || true

echo "🪑 AUTO-SEAT (post-clear, role=${ROLE:-?}) — orient from your resume state below, continue your role; do NOT re-announce (flush, not clock-in). Run 'maw inbox status' for fresh inbox."
echo
cat "$FILE"
