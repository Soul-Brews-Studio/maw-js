---
issue: Soul-Brews-Studio/maw-js#1855
title: Read-only tmux observation for stream and view
status: accepted
date: 2026-05-21
related: "#1852, #1853, #1854, #1856, #1857"
---

# Read-only tmux observation for stream and view

## 1. Decision

Use two explicit mechanisms instead of making one `--readonly` flag mean two
different safety contracts:

- `maw stream <session>:<window>` is a high-fidelity tmux `link-window` mirror.
  It intentionally shares the source window object and does not promise
  read-only isolation.
- `maw view <agent> --readonly` is the default read-only observer path. It keeps
  tmux fidelity by attaching the client with tmux read-only mode
  (`attach-session -r`, or `switch-client -r` when already inside tmux).
- A future strict observer mode, if needed, should use `pipe-pane` into a
  separate destination pane. That mode trades terminal fidelity for a true
  one-way path from source output to observer display.

This resolves the original #1855 A/B choice by splitting the contract:
fidelity-first read-only uses tmux client read-only mode; safety-first
read-only remains a separate, explicit strict mode.

## 2. Why not `maw stream --readonly`

`maw stream` now owns the #1853 link-window mirror semantics. `link-window`
links the same tmux window object into another session; it is not an isolated
copy. A client attached without tmux read-only flags can still type into that
linked window, and the input reaches the source.

Because that risk belongs to the linked-window mechanism itself, a
`maw stream --readonly` flag would be misleading unless it controlled every
client that can attach to the destination session. The CLI cannot enforce that
against raw `tmux attach`, existing clients, or future clients.

Operators who want to observe without typing should use:

```sh
maw view <agent> --readonly
```

Operators who want to mirror a window into another session should use:

```sh
maw stream <source-session>:<window> --into <destination-session>
```

## 3. Accepted mechanisms

### 3.1 Fidelity-first read-only: tmux read-only client

Used by `maw view --readonly`.

Behavior:

- outside tmux: `tmux attach-session -r -t <view-session>`
- inside tmux: `tmux switch-client -r -t <view-session>` only when the current
  client is not already read-only

The inside-tmux guard matters because `switch-client -r` toggles the tmux
client read-only flag. `maw` must check `#{client_readonly}` first so a
read-only client is not accidentally switched back to writable.

Safety contract:

- The current `maw`-managed client cannot type into the source.
- The source view is still a grouped tmux session and can be reached by a
  writable client outside this command.

### 3.2 Mirror: link-window

Used by `maw stream`.

Behavior:

- links an existing source window into a destination session with
  `tmux link-window`
- preserves colors, layout, alternate screen state, scrollback behavior, and
  interactive tmux window identity

Safety contract:

- This is not a read-only mechanism.
- It is suitable for trusted mirrors, cross-session visibility, and operator
  workspace layout.

### 3.3 Strict read-only: pipe-pane

Future option only.

Behavior:

- source pane output is piped with `tmux pipe-pane -O`
- destination pane renders that stream, for example through `tail -f`, `cat`,
  or a small renderer

Safety contract:

- The observer pane has no tmux input path back to the source.
- Fidelity is lower: scrollback, alternate screen, control sequences, and
  interactive terminal state may not match a real tmux client.

## 4. Current guards

`maw view --readonly` is intentionally narrow until each transport can enforce
the same read-only contract:

- `--readonly --split` is rejected because split view currently opens through a
  writable nested attach path.
- remote `--readonly` is rejected because the remote attach helper does not yet
  expose a read-only flag.
- `maw stream` has no deprecated `--readonly` alias because its linked-window
  contract is different from observer read-only.

These are safety guards, not permanent design limits. They can be lifted when
the relevant transport has explicit read-only plumbing and tests.

## 5. Follow-up criteria

Before adding strict read-only or widening `view --readonly`, require tests for:

- local attach uses `attach-session -r`
- inside-tmux switch preserves an already read-only client
- split view cannot type into the source when `--readonly` is accepted
- remote view forwards read-only attach flags end to end
- strict mode proves source input is unreachable from the observer pane

## 6. Summary

Read-only is a safety contract, not just a display preference. `maw view
--readonly` may promise a read-only tmux client because it controls the attach
path. `maw stream` may not promise read-only because link-window is a shared
window mirror. If the fleet needs stronger observer isolation, add it as an
explicit strict pipe-pane mode with the lower-fidelity trade-off visible in the
CLI and docs.
