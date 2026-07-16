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
maw hey "$ADDR" "[hook] $CREW_ROLE idle (turn end) — state: ${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md" >/dev/null 2>&1 &
exit 0
