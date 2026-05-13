# maw shell

Spawn an interactive tmux shell session, attached by default (#1304).

## Usage

```
maw shell <name>              # create + attach (default)
maw shell <name> --no-attach  # create only, attach later via `maw a <name>`
```

## When to use

- Open a clean shell in a named tmux session (e.g. for a repo, an experiment, a long-running editor).
- Pair with `maw a <name>` to reattach across terminals.

## When NOT to use

- For background services / daemons → use [`maw bg`](../bg/SKILL.md) (default detached, takes a `<cmd>`).
- For splitting the current pane → use `maw pane split`.

## Behavior

- Creates `tmux new-session -d -s <name> -c $PWD`.
- If `--no-attach` is absent, immediately attaches (`tmux attach` or `switch-client` inside tmux).
- Refuses to clobber an existing session — fails loudly with attach/kill hint.

## Related

- `maw bg` — sibling verb, opposite default, takes `<cmd>` (#1304).
- `maw pane split` — split current pane instead of new session.
- `maw a` / `maw kill` — attach to / kill named sessions.
