# `team-agents` vs `maw team`

Both `team-agents` (Claude Code skill) and `maw team` (maw plugin) spin up coordinated agent teams. They overlap heavily but solve different layers. This document captures the differences side-by-side as a reference for picking between them.

## Side-by-side

| Dimension | `team-agents` | `maw team` |
|---|---|---|
| **Layer** | Claude Code session-internal | Maw fleet-level (cross-session) |
| **Plugin path** | `~/.claude/skills/team-agents/` | `~/.maw/plugins/team/` |
| **Activation** | `/team-agents <task>` | `maw team <verb>` |
| **Env requirement** | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | None (always on) |
| **Display modes** | `in-process` / `tmux` (toggle via `~/.claude.json` or `--teammate-mode`) | tmux only (panes) |
| **Verbs** | who, zoom, sync, merge, compile, shutdown, cleanup, killshot, doctor | create, spawn, send, shutdown, resume, lives, list, status, add, tasks, done, assign, delete, invite, oracle-invite, oracle-remove, members |
| **Members** | Subagents (Agent tool) | Subagents + **federation oracles** (`oracle-invite`) |
| **Session scope** | One team per session, no resume | Persistent across sessions, `resume` + `lives` |
| **Worktree integration** | `--worktree` flag, `agents/<name>` branches | Not built-in (yet?) |
| **Heartbeat protocol** | Custom (PROGRESS/STUCK/DONE/ABORT, 5-min, layered on top) | Built-in via `team-lifecycle` / `team-status` |
| **Mailbox / persistence** | JSON + file locking via Claude Code base | `task-ops.ts` + `team-comms.ts` |
| **Plan auto-approval** | `--plan` flag | n/a (different model) |
| **Quality gate hooks** | TeammateIdle / TaskCreated / TaskCompleted | Not exposed (yet?) |
| **Manual mode** | `--manual` (standby + lead relay) | n/a — different lifecycle (`spawn` is the equivalent) |
| **Cross-repo / cross-host** | No (single repo, single session) | Yes (federation peers via `oracle-invite`) |

## Where each shines

**`team-agents`** wins for: tight in-session work, code reviews/refactors needing 3-5 specialist subagents, anything benefiting from `--worktree` branch isolation, hook-driven quality gates.

**`maw team`** wins for: persistent teams that survive across sessions, federation-aware coordination (pulling in `m5:m5-keeper` or `white-wormhole` as members), fleet-level orchestration, anything that needs `resume` after the lead session ends.

## The killer differentiator

`maw team oracle-invite` brings federation oracles into a team. `team-agents` cannot do this — it operates inside a single Claude Code session and spawns subagents only. That's the dividing line: in-session vs cross-oracle.

## Open questions

- Can `maw team` use `--worktree`-style git isolation, or is that team-agents-only?
- Does `maw team resume` work across host reboots (fleet-level persistence)?
- What's the migration path from a `team-agents` session to a persistent `maw team` (e.g. via `compile` → `maw team create` rehydration)?
- Are quality-gate hooks (TaskCompleted etc.) usable inside `maw team`?

## References

- `team-agents` skill: `~/.claude/skills/team-agents/SKILL.md`
- `maw team` plugin: `~/.maw/plugins/team/` (13 TS modules)

— Compiled from #814 (mawjs-2-oracle audit, 2026-04-28)
