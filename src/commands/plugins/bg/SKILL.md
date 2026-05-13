# maw bg

Spawn a detached tmux session running a command (#1304). Returns immediately.

## Usage

```
maw bg <name> "<cmd>"            # spawn + return (default)
maw bg <name> "<cmd>" --attach   # spawn AND attach (rare)
```

## When to use

- Start a long-running background service from the terminal you're in (`bun run dev`, `tail -f log.txt`, watchers, agents).
- Kick off something while continuing to work in the current shell.
- Spawning a service from a Claude session that wants the work to outlive its own pane.

## When NOT to use

- For an interactive shell → use [`maw shell`](../shell/SKILL.md) (default attached, no `<cmd>`).
- For splitting the current pane to show output → use `maw pane split "<cmd>"`.

## Behavior

- Creates `tmux new-session -d -s <name> -c $PWD <cmd>`.
- Default detached. Pass `--attach` to attach after spawning.
- Refuses to clobber an existing session — fails loudly with attach/kill hint.
- Output goes to the session's pane buffer (inherited stdio). Read with `maw a <name>` or `maw tmux peek <name>`.

## Out of scope (v1)

- Process management (kill / restart / list-running) — use `maw kill <name>`.
- Log redirection beyond tmux's pane buffer.
- A `--shell` flag (v2 polish, see issue #1304 body).

## Related

- `maw shell` — sibling verb, opposite default, no `<cmd>` (#1304).
- `maw pane split` — split current pane instead of new session.
- `maw a` / `maw kill` — attach to / kill named sessions.
