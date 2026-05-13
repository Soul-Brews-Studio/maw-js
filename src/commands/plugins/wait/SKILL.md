# maw wait

Block until a tmux session named `<name>` no longer exists (#1306). Returns immediately if the session never existed.

## Usage

```
maw wait <name>                        # poll every 5s, no timeout
maw wait <name> --interval 1           # poll every 1s
maw wait <name> --timeout 600          # bail after 10 min
maw wait <name> --interval 1 --timeout 600
```

## When to use

After `maw bg <name> "<cmd>"` (#1304), when you want to block the current shell until that background command finishes — e.g. to chain a builder, a fetcher, or a one-shot task.

```bash
maw bg builder "bun run build"
maw wait builder
echo "build done — running tests"
maw bg tests "bun test"
maw wait tests
```

Mirrors POSIX shell `wait %1`. Same shape as `until ! tmux has-session -t … ; do sleep 5; done`, made first-class.

## When NOT to use

- For interactive sessions you started with `maw shell` — they exit when the human types `exit`, not on a schedule. `maw wait` works, but the semantics are different (you're waiting for a human, not a job).
- When you need the spawned process's exit code — `maw wait` only sees "is the session alive?", not the command's exit status. Use `maw bg` log capture (separate issue) or read `tmux capture-pane` once it ends.

## Behavior

- Polls `tmux has-session -t <name>` every `--interval` seconds.
- Returns immediately if the session never existed.
- With `--timeout`, throws (ok=false) after the deadline; the error message is prefixed `timeout: …` so callers can distinguish from arg errors.

## Out of scope (v1)

- Exit-code propagation from the wrapped command. Tracked separately.
- Waiting on multiple names (`maw wait foo bar baz`). Punt to v2 unless needed.
- Waiting on remote / `maw a` peer sessions.

## Related

- `maw bg <name> "<cmd>"` — sibling verb that spawns the session (#1304).
- `maw shell <name>` — sibling verb for interactive shells (#1304).
- `maw kill <name>` — force-end a session (causes `maw wait` to return).
