#!/bin/bash
# crew worker Stop hook — deterministic completion signal (kobo-91 TEST2 deadlock fix)
# Fires on every turn end, but ONLY in panes spawned with CREW_ROLE=worker-N
# (env gate = local-first: non-crew panes exit instantly, coord/lead unaffected).
case "$CREW_ROLE" in worker-*) ;; *) exit 0 ;; esac
[ -n "$CREW_COORD_PANE" ] || exit 0
# resolve coord addr fresh from stable pane-id (index shifts, pane-id doesn't)
ADDR=$(tmux display-message -t "$CREW_COORD_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
[ -z "$ADDR" ] && exit 0
maw hey "$ADDR" "[hook] $CREW_ROLE idle (turn end) — state: ψ/active/crew/$CREW_ROLE.md" >/dev/null 2>&1 &
exit 0
