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

# State dirs to search. CREW_STATE_DIR (crew/warroom panes export it) is authoritative — search
# only that. Else search BOTH ψ/active/crew and ψ/active/warroom: a repo can hold both (an empty
# leftover crew/ beside a populated warroom/), so we must NOT blind-pick one dir up front — the
# winner is decided below by which dir actually holds THIS role's resume file (kobo-269: an empty
# crew/ was shadowing a populated warroom/ → lead never seated).
DIRS=""
if [ -n "${CREW_STATE_DIR:-}" ]; then
  D="${CREW_STATE_DIR}"; case "$D" in /*) ;; *) D="$ROOT/$D" ;; esac
  DIRS="$D"
else
  [ -d "$ROOT/ψ/active/crew" ]    && DIRS="$DIRS $ROOT/ψ/active/crew"
  [ -d "$ROOT/ψ/active/warroom" ] && DIRS="$DIRS $ROOT/ψ/active/warroom"
  [ -d "$ROOT/ψ/active/worker" ]  && DIRS="$DIRS $ROOT/ψ/active/worker"
fi
[ -n "$DIRS" ] || exit 0   # not a crew/warroom/worker repo → nothing to seat (solo-safe).

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

# Candidate filenames by role — first that exists wins. Covers crew's role-named files
# (worker-1.md) AND warroom's special names (lead-handoff.md / worker.md).
case "$STEM" in
  lead)       NAMES="lead-handoff.md lead.md" ;;   # eq3 fix: lead → lead-handoff.md
  worker-*)   NAMES="$STEM.md worker.md" ;;        # crew worker-1.md, else warroom worker.md
  worker)     NAMES="worker.md" ;;
  reviewer)   NAMES="reviewer.md worker.md" ;;
  conduct*)   NAMES="conductor.md" ;;
  comm)       NAMES="comm.md" ;;
  coord)      NAMES="coord.md" ;;
  *)          exit 0 ;;
esac
# Search each dir for this role's files; the dir that HOLDS a file wins (so an empty crew/ can't
# shadow a populated warroom/). Names are inner so a dir's preferred file beats its fallback.
FILE=""
for d in $DIRS; do
  for n in $NAMES; do [ -f "$d/$n" ] && { FILE="$d/$n"; break 2; }; done
done
[ -f "$FILE" ] || exit 0

# Clear the away-flag so hey delivers again (mirrors /seat step 2.5, silent).
maw presence back >/dev/null 2>&1 || true

# kobo-297 — surface the flip: `maw presence back` above is a silent background write,
# so a human couldn't tell a /clear'd pane actually re-seated (vs stuck away). Print one
# glanceable confirmation. Phrased as the resulting state (always true after `back`) —
# seat-resume runs on every SessionStart(clear), not only when the pane was away, so it
# does NOT falsely claim "was away". The persistent badge (maw-statusline.sh) shows away→online.
echo -e "\x1b[32m● presence: online (auto-seated)\x1b[0m"

echo "🪑 AUTO-SEAT (session start, role=${STEM}) — orient from your resume state below, continue your role; do NOT re-announce (flush, not clock-in). Run 'maw inbox status' for fresh inbox."
echo
cat "$FILE"
