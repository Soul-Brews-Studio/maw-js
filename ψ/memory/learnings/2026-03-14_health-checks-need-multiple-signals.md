# Health Checks Need Multiple Signals

**Date**: 2026-03-14
**Source**: maw-js dead oracle detection
**Context**: `maw ls` showed `neo-oracle-skills-cli` as healthy (blue dot) because Claude process was running, but the working directory had been deleted by worktree cleanup.

## Pattern

A single health signal creates false positives. For tmux-based agent monitoring:

| Signal | What it catches | What it misses |
|--------|----------------|----------------|
| Process name (`claude`) | Shell-only windows | Deleted paths, stuck agents |
| Working directory exists | Deleted worktrees | Crashed processes |
| Recent output change | Frozen agents | Agents waiting for input |

**Combine signals**: process alive + path exists = minimum viable health check.

## Implementation

tmux provides `#{pane_current_command}` and `#{pane_current_path}` in a single query. Deleted directories show as `path (deleted)` in the path field. Batch-query with `getPaneInfos()` for performance.

## Broader Application

Any system health check: don't trust a single probe. A container can be "running" with a dead app inside. A database can accept connections but have corrupt data. A CI job can pass with zero tests executed.

**Rule**: If you can think of a state where probe=true AND system=broken, add another probe.
