#!/bin/bash
# crew worker Stop hook — deterministic completion signal (kobo-91 TEST2 deadlock fix)
# Fires on every turn end, but ONLY in panes spawned with CREW_ROLE=worker
# or CREW_ROLE=reviewer (kobo-204: reviewer pane needs the same deterministic
# idle signal so front records the verdict + tears it down without polling).
# (env gate = local-first: non-crew panes exit instantly, coord/lead unaffected).
# glob `worker*` matches bare "worker" (kobo-319 single-pane) AND any historical
# worker-N pane still running mid-migration — both must keep signaling idle.
case "$CREW_ROLE" in worker*|reviewer) ;; *) exit 0 ;; esac
[ -n "$CREW_COORD_PANE" ] || exit 0
# resolve coord addr fresh from stable pane-id (index shifts, pane-id doesn't)
ADDR=$(tmux display-message -t "$CREW_COORD_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
[ -z "$ADDR" ] && exit 0
# kobo-356: attach the board-read next-ready queue to a WORKER's idle ping so the
# conductor can dispatch immediately without a separate query round-trip
# (event-driven — this call only fires because the Stop hook already fired, no
# loop/poll). reviewer idle carries no queue signal (reviewer doesn't pick up cards).
QUEUE=""
case "$CREW_ROLE" in
  worker*)
    if [ -n "$MAW_ROOM_COMPANY" ]; then
      QUEUE=$(maw company task next-ready --company "$MAW_ROOM_COMPANY" 2>/dev/null | tail -1)
    fi
    ;;
esac
MSG="[hook] $CREW_ROLE idle (turn end) — state: ${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md"
[ -n "$QUEUE" ] && MSG="$MSG · $QUEUE"
maw hey "$ADDR" "$MSG" >/dev/null 2>&1 &
exit 0
