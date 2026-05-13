---
name: split
description: Carve the caller's tmux pane and attach to (or open a shell in) a fleet session.
---

# `maw split <target>`

Split the current tmux pane and, by default, attach to `<target>` in the new pane.

> **The pane it carves is YOUR pane.** Without `--from`, every split slices
> the caller's pane in half — the new pane is created beside (or below) the
> one you typed the command from. This is by design (matches the implicit
> behavior of raw `tmux split-window`) but is the source of the #1303 foot-gun
> when run from inside a Claude Code session.

## Synopsis

```
maw split <target> [--pct N] [--vertical] [--no-attach] [--from <pane>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--pct N` | `50` | Width (or height, with `--vertical`) of the new pane, 1–99. |
| `--vertical` | off | Split top/bottom instead of side-by-side. |
| `--no-attach` | off | Open a plain shell in the new pane — don't `attach-session` to `<target>`. |
| `--from <pane>` | `$TMUX_PANE` | Anchor pane to carve. Pass a `%N` pane id or another oracle's session to slice a peer's pane instead of your own. |

## Target resolution

- `session:window` → used verbatim
- `session` → resolves to `session:window[0]`
- bare oracle name → finds the fleet session matching `*-<name>` or exact `<name>`

Resolution rules live in `src/core/matcher/resolve-target.ts` — same rules as
the rest of maw (exact > suffix/prefix fuzzy > ambiguous → loud error).

## Carve semantics

`maw split` is a **carving** verb: it always splits an existing pane, and the
default anchor is `$TMUX_PANE` (the pane you're typing in).

```
┌──────────────┐         ┌──────┬───────┐
│              │   →     │      │       │
│  your pane   │         │ your │ new   │
│              │         │ pane │ pane  │
└──────────────┘         └──────┴───────┘
```

To carve a peer's pane instead of your own, use `--from %N` (or `--from session:window`).
This is how `maw view` lays out fleet panes side-by-side without touching the
caller's session.

## When NOT to use `maw split`

If you want to launch a process **without** carving your current pane, use
the non-carve verbs from #1304:

| Goal | Use |
|---|---|
| open an interactive shell on a peer oracle without slicing yours | `maw shell <name>` |
| run a background command on a peer oracle without slicing yours | `maw bg <name> "<cmd>"` |
| carve a peer's pane intentionally (debugging layout) | `maw split <name> --from <pane>` |
| carve your own pane to attach to a peer (classic flow) | `maw split <name>` |

## The Claude foot-gun (#1303)

Running `maw split <name> --no-attach` from inside a Claude Code session
without `--from` would silently carve the Claude pane — three back-to-back
calls would carve it three times, leaving the AI session in a 1/8th-width
sliver.

Since alpha v26.5.13, this exact combination refuses with:

```
refusing to carve caller's pane: would slice the claude-like pane '%42' (running 'claude').
  use `maw shell <name>` for a non-carve interactive shell (#1304)
  use `maw bg <name> "<cmd>"` for a non-carve background command (#1304)
  use `--from <oracle>` (or `-t <pane>` for `maw pane split`) to carve a different pane intentionally
```

Heuristic: caller pane's `pane_current_command` is checked via
`isClaudeLikePane()` (substring `claude` or `N.N.N` version pattern) at the
top of `cmdSplit`. The same gate is mirrored in `maw pane split` — both
verbs share `callerPaneCarveRefusal()` from `tmux/safety.ts` so the error
string is byte-identical.

Escape hatches:
- explicit `--from <pane>` (any non-Claude anchor disables the gate)
- `--no-attach` is not the gating condition alone — only `--no-attach` *and*
  no `--from` *and* a Claude-like caller all together trigger refusal.

## See also

- `maw shell` / `maw bg` — non-carve peer-launch verbs (#1304)
- `maw pane split` — lower-level primitive (no fleet target resolution)
- `maw view` — multi-pane fleet dashboard (uses `--from` internally)
