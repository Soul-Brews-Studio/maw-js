---
name: teardown
description: Gracefully shut down all crew panes in the current session — sends shutdown_request to conductor/worker/reviewer panes, then kills them. Preserves the invoker coord pane and any untagged panes (fail-closed). Use when user says "/teardown", "ปิด crew", or "shutdown crew".
---

# /teardown — graceful crew cell shutdown

> **Safety:** fail-closed by design. Only panes tagged `@role` matching `conductor|worker|reviewer` are killed. Invoker (`ME`) and untagged panes are NEVER touched.

## Steps

### 1. Capture invoker pane-id (NEVER kill ME)

```bash
ME=$(tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')
```

### 2. Enumerate all panes in the session

```bash
tmux list-panes -s -F '#{pane_id} #{@role}'
```

### 3. For each pane — apply fail-closed filter

For each line `PID ROLE` from step 2:

- `PID == ME` → **skip** (never kill invoker)
- `ROLE` is empty → **skip** (untagged = preserve)
- `ROLE` matches `*coord*` → **skip** (preserve)
- `ROLE` matches `*conductor*`, `*worker*`, or `*reviewer*` → **teardown** (step 4)
- anything else → **skip** (fail-closed default)

### 4. Graceful-wrap then kill (per crew pane)

```bash
STATE_DIR="${CREW_STATE_DIR:-ψ/active/crew}"

# For each crew pane (conductor / worker / reviewer):
ADDR=$(tmux display-message -t "$pid" -p '#{session_name}:#{window_index}.#{pane_index}')
maw hey "$ADDR" "shutdown_request — flush state before teardown"
sleep 3
tmux kill-pane -t "$pid"
```

### 5. Cleanup state files

```bash
rm -f "${CREW_STATE_DIR:-ψ/active/crew}"/*.md
```

### 6. Announce done

Reply in the coord pane: "teardown complete — all conductor/worker/reviewer panes closed. coord pane intact."

---

## Safety summary

| Condition | Action |
|-----------|--------|
| `pane_id == ME` | **preserve** — invoker coord, never kill |
| `@role` empty | **preserve** — fail-closed (unknown = safe) |
| `@role` matches `*coord*` | **preserve** |
| `@role` matches `*conductor*` | graceful-wrap → `kill-pane` |
| `@role` matches `*worker*` | graceful-wrap → `kill-pane` |
| `@role` matches `*reviewer*` | graceful-wrap → `kill-pane` |
| `@role` anything else | **preserve** — fail-closed default |

`TMUX_PANE` is the shell variable identifying the invoker. Always capture it into `ME` first — before iterating — so loop context never shadows it.
