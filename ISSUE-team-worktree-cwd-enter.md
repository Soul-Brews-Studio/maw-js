# Issue: Team panes need real worktree cwd and explicit enter

Date: 2026-05-14

## Problem

Live team testing with Somwind showed two related gaps in `maw team`:

1. `maw workon <repo> <role>` creates role-specific worktree windows, but
   `maw team spawn --exec` still splits from the leader pane and starts the
   agent in the leader cwd. Passing `REPO=/abs/worktree` in the prompt is only
   an instruction; it does not make the pane actually run in that worktree.

2. `maw team hey <agent> <message>` can leave long text staged in a Codex TUI
   prompt without submitting it. Operators need a team-scoped way to send an
   Enter key without dropping down to raw tmux.

## Repro

```bash
maw workon Somwind-oracle scout
maw workon Somwind-oracle implementer
maw workon Somwind-oracle verifier

maw team create somwind-wt-horizontal --description "Horizontal team panes with real worktree cwd"
maw team spawn somwind-wt-horizontal implementer --exec \
  --worktree /opt/sila/Code/github.com/sila-build-with-oracle/Somwind-oracle.wt-1-implementer \
  --prompt "REPO=/opt/sila/Code/github.com/sila-build-with-oracle/Somwind-oracle.wt-1-implementer"
```

Expected: the spawned pane's agent starts with the worktree as cwd.

Observed before the fix: team panes could appear in the main repo even though
the prompt named a worktree path.

For prompt submission:

```bash
maw team hey implementer "TASK ..."
```

Observed: text can be visible in the Codex prompt but not executed until a
separate Enter is sent.

## Proposed Fix

- Add `--cwd <path>` and `--worktree <path>` to `maw team spawn`.
- Wrap the spawned agent command with `cd '<path>' && ...` when cwd is present.
- Add `maw team enter <agent|all>` as a team-scoped Enter key surface.

This keeps operators on `maw team` instead of raw `tmux` while preserving the
existing `--exec` split-pane flow.

