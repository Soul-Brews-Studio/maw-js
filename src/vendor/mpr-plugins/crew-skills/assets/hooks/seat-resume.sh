#!/usr/bin/env bash
# Auto-seat (kobo-268): on startup / resume / clear, re-orient THIS crew or warroom pane by
# injecting its role-specific resume file as SessionStart additionalContext — the (re)started
# session wakes up already seated, no manual /seat needed.
#
# Resolution mirrors the crew Stop hook (the established pattern): role + state-dir come from
# the CREW_ROLE / CREW_STATE_DIR env the pane was spawned with (so crew → ψ/active/crew,
# warroom → ψ/active/warroom, automatically). tmux @role is a durable fallback when the env is
# absent (e.g. a manual re-launch — @role sticks to the pane). The resume file is the exact
# role file ($DIR/<role>.md, e.g. crew's worker-1.md) with the warroom special names
# (lead-handoff.md / worker.md) as fallbacks.
#
# Solo-safe: no crew/warroom state dir OR no resolvable role → exit silent (a plain pane is
# untouched). eq3 prove-first (warroom); generalized here to also seat crew's ψ/active/crew
# layout so it dogfoods on patchwork.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# State dir: honor CREW_STATE_DIR (crew/warroom panes export it); else default crew/, else
# warroom/ if that's the one present. Resolve to an absolute path under the repo.
DIR="${CREW_STATE_DIR:-}"
if [ -z "$DIR" ]; then
  if [ -d "$ROOT/ψ/active/crew" ]; then DIR="$ROOT/ψ/active/crew"
  elif [ -d "$ROOT/ψ/active/warroom" ]; then DIR="$ROOT/ψ/active/warroom"
  else exit 0   # not a crew/warroom repo → nothing to seat (solo-safe).
  fi
fi
case "$DIR" in /*) ;; *) DIR="$ROOT/$DIR" ;; esac
[ -d "$DIR" ] || exit 0

# Role: prefer CREW_ROLE env (same signal the Stop hook uses), else the durable tmux @role.
ROLE="${CREW_ROLE:-}"
[ -n "$ROLE" ] || ROLE="$(tmux display-message -t "${TMUX_PANE:-}" -p '#{@role}' 2>/dev/null || true)"
# Bare role token out of any decoration/glyph/quoting (e.g. "⚒ worker-1" or "⚒ worker-'1'"
# → "worker-1"). Strip quotes first so a stray-quoted @role still resolves the numbered file.
# LOWERCASE the token: labels are capitalized ("🎼 Conductor") but the case globs below are
# case-sensitive — without this, Conductor never matched conduct* and exited silent (kobo-268).
ROLE="$(printf '%s' "$ROLE" | tr -d "\"'")"
STEM="$(printf '%s' "$ROLE" | grep -oiE 'worker-[0-9]+|reviewer|conduct[a-z]*|worker|lead|comm|coord' | head -1 | tr '[:upper:]' '[:lower:]')"
[ -n "$STEM" ] || exit 0   # unknown/empty role → don't guess, stay silent.

# File candidates by role — first that exists wins. Covers crew's role-named files
# (worker-1.md) AND warroom's special names (lead-handoff.md / worker.md).
case "$STEM" in
  lead)       CANDS="$DIR/lead-handoff.md $DIR/lead.md" ;;      # eq3 fix: lead → lead-handoff.md
  worker-*)   CANDS="$DIR/$STEM.md $DIR/worker.md" ;;           # crew worker-1.md, else warroom worker.md
  worker)     CANDS="$DIR/worker.md" ;;
  reviewer)   CANDS="$DIR/reviewer.md $DIR/worker.md" ;;
  conduct*)   CANDS="$DIR/conductor.md" ;;
  comm)       CANDS="$DIR/comm.md" ;;
  coord)      CANDS="$DIR/coord.md" ;;
  *)          exit 0 ;;
esac
FILE=""
for c in $CANDS; do [ -f "$c" ] && { FILE="$c"; break; }; done
[ -f "$FILE" ] || exit 0

# Clear the away-flag so hey delivers again (mirrors /seat step 2.5, silent).
maw presence back >/dev/null 2>&1 || true

echo "🪑 AUTO-SEAT (session start, role=${STEM}) — orient from your resume state below, continue your role; do NOT re-announce (flush, not clock-in). Run 'maw inbox status' for fresh inbox."
echo
cat "$FILE"
