# Team & Coordination Features

> Reference guide for every team-shaped, multi-agent, and cross-pane feature in the maw-js ecosystem. Generated 2026-05-27 from a full enumeration of plugins, skills, and federation primitives.

This document is the canonical answer to "**how do I coordinate multiple agents in maw-js?**" The surface is larger than it looks — there are at least **20 distinct team/coordination verbs** plus 4 Claude Code APIs, 10+ user skills, and 6 sibling repos. They overlap on purpose: each was built for a specific shape of work.

For sprint charters that spawn Codex/Claude builders from a YAML pattern, see [Codex Team Pattern](./codex-team-pattern.md).

> **Naming footgun — singular vs plural:** `/team-agent` and `/team-agents` are **not aliases**.
>
> - `/team-agent` (singular) opens the guided wizard for the shell-driven `maw team-agent` plugin.
> - `/team-agents` (plural) opens the Claude Code coordinated-team skill for session-scoped teams.
>
> If you are choosing from memory, check the trailing **s** before invoking the flow.

## Quick map

```
                                       Federation (cross-machine)
                                       ▲
                                       │ oracle-invite, maw hey, port 3456
                                       │
        ┌──── persistent ──────────────┼──── ephemeral ────────────────┐
        │                              │                                │
        │  maw team                    │      /team-agents              │
        │  ─────────                   │      ────────────              │
        │  • 23 subcmds                │      • 3-tier fallback         │
        │  • reincarnation             │      • heartbeat protocol      │
        │  • cross-machine             │      • quality-gate hooks      │
        │  • resume tomorrow           │      • one team per session    │
        │                              │      • worktree isolation      │
        └──── fleet-level ─────────────┼──── session-level ─────────────┘
                                       │
                  Support primitives:  │  tile · swarm · bring · tag
                                       ▼
                                       tmux (Layer 0)
```

## Decision tree

```
Is the work going to outlive this session?
├─ YES  → Will it span multiple machines?
│        ├─ YES → maw team + oracle-invite
│        └─ NO  → maw team (single-machine, persistent)
│
└─ NO   → Will members need to coordinate via structured messages?
         ├─ YES → /team-agents (Claude Code skill)
         │       │  with worktree isolation? add --worktree
         │       │  with mixed shapes (Plan + general)? compose via subagents
         │
         └─ NO  → Are you A/B-comparing engines?
                  ├─ YES → maw swarm
                  └─ NO  → Just want a peer visible? → maw bring
                           Just spawning N panes?     → maw tile [N]
```

## Layer architecture

The team surface is **stacked**. Each layer adds something the layer below cannot do:

| Layer | What lives here | What it adds |
|---|---|---|
| **L0** | tmux sessions / windows / panes | Splits, no identity |
| **L1** | maw verbs (`team`, `tile`, `swarm`, `bring`, `tag`, etc) | Fleet identity, federation routing, persistence |
| **L2** | Claude Code native APIs (`TeamCreate`, `SendMessage`, `TaskCreate`, `TeamDelete`) | In-process inboxes, JSON wire format, task graph |
| **L3** | User skills (`/team-agents`, `/team-tile-spawn`, `/team-down`, etc) | Workflows that compose L1+L2 |
| **L4** | Demos (`/full-auto-long-demo`, `/team-tile-demo`) | End-to-end automation with self-cleanup |

The **bridge skill** that exercises every layer is `/team-tile-spawn`:

```
maw tile N           → L0 + L1 (tmux + fleet-registered panes)
tmux select-layout   → L0    (arrange)
TeamCreate           → L2    (register team)
maw run × N          → L1+L2 (boot engines AS team members via env)
SendMessage × N      → L2    (deliver missions)
```

## Full verb reference

### Coordination (L1 — maw plugins)

| Verb | Alias | Layer | Purpose | Status |
|---|---|---|---|---|
| `maw team` | `t` | L1 | Persistent fleet team, 23 subcommands, reincarnation engine | ACTIVE v2.0.1 |
| `maw team-agent` | — | L1 | Shell-driven `TeamCreate` wrapper (no Claude tools needed) | ACTIVE v1.2.0 |
| `maw swarm` | — | L1 | Multi-engine A/B panes (no coordination layer) | ACTIVE |
| `maw broadcast` | `shout` | L1 | Send message to all team members | ACTIVE |
| `maw avengers` | — | L1 | Multi-agent Avengers team framework | ACTIVE |
| `maw mega` | — | L1 | MegaAgent multi-agent teams | ACTIVE |
| `maw reunion` | — | L1 | Federation-wide reunion sync trigger | ACTIVE |
| `maw oracle-workon` | — | L1 | Worktree team — composes `wake --task --split` + `swarm` | ALPHA |
| `maw pair` | — | L1 | Ephemeral federation pairing (accept-code flow) | ACTIVE |
| `maw cross-team-queue` | — | L1 | Unified inbox across vaults | ACTIVE |
| `maw scope` | — | L1 | Named routing namespaces (Phase 1 #642) | ACTIVE |
| `maw tag` | — | L1 | Pane metadata for routing | ACTIVE |
| `maw buddy` | — | L1 | Cross-engine pairing (spec ↔ impl) | SCAFFOLD (in maw-plugin-registry) |

### Pane & window management (L1)

| Verb | Alias | Purpose |
|---|---|---|
| `maw tile [N]` | — | Arrange current window into grid, or spawn N panes. Post-#1837: `--path --cmd` spawns + cd + boot in one verb |
| `maw bring <oracle>` | `b` | Bring oracle into current view (thin alias for `wake --split`) |
| `maw take <src:win> <dst>` | — | Move tmux window between oracle sessions |
| `maw promote <session:window>` | — | Eject window to its own standalone session |
| `maw open` | — | Bring back hidden panes (join-pane) |
| `maw close` | — | Hide panes without killing |
| `maw zoom <pane>` | — | Toggle zoom |
| `maw pane swap <a> <b>` | — | Reorder panes in current window |
| `maw panes` | — | List pane metadata across fleet |
| `maw view <agent>` | — | Read-only tmux view of an agent's pane |

### Lifecycle (L1)

| Verb | Alias | Purpose |
|---|---|---|
| `maw wake <oracle>` | — | Wake/reuse oracle session, fuzzy resolve, auto-clone if needed |
| `maw awake <oracle>` | — | Launch oracle process with engine (no `/awaken` ritual) |
| `maw new <name>` | `n` | Create plain tmux workspace session |
| `maw attach <name>` | `a` | Attach to live session, or wake from fleet |
| `maw done <worktree>` | — | Finish worktrees gracefully (cleanup paired worktree + session) |
| `maw sleep <target>` | — | Graceful process stop |
| `maw kill <target>` | — | Immediate kill |
| `maw restart <target>` | — | Restart a session |
| `maw cleanup` | — | Clean zombie agent panes and prune stale registry |
| `maw preflight` | — | Pre-flight: version, plugins, dead agents, config |

### Messaging & communication (L1)

| Verb | Alias | Purpose |
|---|---|---|
| `maw hey <target> "<msg>"` | — | Signed identity-envelope message with pane injection + Enter (post #1388) |
| `maw send <target> "<msg>"` | — | Alias of `hey` (re-routed by route-comm.ts) |
| `maw notify <target> "<msg>"` | — | Inbox-only push, no pane injection (#1882) |
| `maw send-text <pane> "<txt>"` | — | Raw text into pane, no envelope, no Enter |
| `maw broadcast "<msg>"` | `shout` | Fleet-wide |
| `maw peek <target>` | — | Federation-aware pane read |
| `maw capture <pane>` | — | Pane scrollback dump (`--full` for everything) |
| `maw follow <pane>` | — | Live tail of pane output (`--since`, `--grep`, `--quit-on-idle`) |
| `maw activity <pane>` | — | Classify pane state (busy / idle / stuck) |
| `maw inbox <oracle>` | — | Inbox management (read / approve / reject / drain) |
| `maw talk-to <oracle>` | — | Cross-oracle signed message via federation |
| `maw ping <node>` | — | Federation health check |

### Federation (L1)

| Verb | Alias | Purpose |
|---|---|---|
| `maw federation` | `fed` | Multi-node sync status & control |
| `maw discover` | — | List federation peers & tmux state (`--peers config\|scout\|both`) |
| `maw workspace` | — | Multi-node workspace management |
| `maw peers` | — | Peer inventory |
| `maw transport` | `tp` | Transport layer status |
| `maw locate <oracle>` | — | Find oracle across federation |
| `maw about <oracle>` | — | Show oracle metadata |
| `maw on <oracle> <event>` | — | Listen for oracle events (`--once`, `--timeout`) |

### Tasks (L1 → L2 bridge)

| Verb | Layer | Purpose |
|---|---|---|
| `maw pulse` | L1 | Task pulse (`add`, `ls`, `cleanup`) |
| `maw assign <issue-url>` | L1 | Assign issue to oracle |
| `maw workon <repo>` | L1 | Create worktree (`--layout nested\|legacy`) |
| `TaskCreate` | L2 | Claude Code task with `addBlockedBy` dependencies |
| `TaskUpdate` | L2 | Status / blocker updates |
| `TaskList` | L2 | Query task graph |

### Claude Code native APIs (L2)

| Tool | Used by |
|---|---|
| `TeamCreate({name, members})` | `/team-agents`, `/team-tile-spawn`, `maw team-agent create` |
| `SendMessage({to, payload})` | All session-team paths; `to: "<role>@<team>"`; JSON inbox + XML wire wrap |
| `TaskCreate / Update / List` | `/team-agents` task graph coordination |
| `TeamDelete({name})` | All teardown paths |

These are **deferred tools** — they don't appear by default. Load via `ToolSearch` or set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` at session start.

### User skills (L3)

| Skill | Purpose | Status |
|---|---|---|
| `/team-agents` | 3-tier coordinated teams (tmux / in-process / subagents); subcommands `who/zoom/sync/merge/compile/shutdown/cleanup/killshot/doctor` | ACTIVE |
| `/team-agent` (singular!) | Guided wizard for `maw team-agent` plugin; 10-step walkthrough; presets blank/solo/pair/trio/review/stack | ACTIVE |
| `/team-tile-spawn` | One-shot bootstrap exercising all 4 layers | ACTIVE |
| `/team-tile-demo` | 12-step narrated walkthrough; documents 6 empirical seams | ACTIVE |
| `/team-down` | Safe teardown (replaces buggy `killshot` after arra#411) | ACTIVE |
| `/tile` | Spawn tiled agent panes with worktrees + claude | ACTIVE |
| `/tile-fix` | Re-apply correct tmux layout | ACTIVE |
| `/maw-workon` | Spawn worker pane in current oracle session | ACTIVE |
| `/oracle-workon` | Worktree + team for oracle task | ACTIVE |
| `/forward-bg` | Background handoff writer via Haiku subagent (non-blocking) | ACTIVE |
| `killshot` (subcommand) | Old teardown — **DEPRECATED**, has lead-kill bug (arra#411) | DEPRECATED |

### Demos (L4)

| Skill | Purpose |
|---|---|
| `/full-auto-long-demo` | Zero-arg end-to-end (12 steps), self-cleans. Smoke test for the team stack |
| `/team-tile-demo` | Long-form narrated (also in L3 — it's both reference and demo) |

## `maw team` subcommand reference

The 23 subcommands of `maw team` (run `maw team --help` for the live list):

| Group | Subcommands |
|---|---|
| **Lifecycle** | `create` · `spawn` · `spawn-from` · `bring` · `send` · `shutdown` · `resume` · `lives` |
| **Setup** | `plan` · `preflight` · `load` |
| **Status** | `list` · `status` · `members` |
| **Tasks** | `add` · `tasks` · `done` · `assign` |
| **Manage** | `delete` |
| **Federation** | `invite` · `oracle-invite` · `oracle-remove` |
| **Misc** | `enter` |

### Distinctive features

1. **Reincarnation engine** — if a pane dies (tmux killed, shell exited, engine crashed), `maw team resume` recreates from registry, restores cwd, re-launches engine, replays recent inbox messages.
2. **Federation via `oracle-invite`** — `maw team oracle-invite phaith:01-hojo` invites an oracle on another machine to join. Messages route over HTTP federation API at port 3456.
3. **No session limit** — unlike `/team-agents` (one team per session), `maw team` lets you run 26+ concurrent teams (proven 2026-05-14).

## `maw team-agent` subcommand reference

A **separate plugin** (v1.2.0), not subcommands of `maw team`:

| Subcommand | Purpose |
|---|---|
| `create <name> [desc]` | Register team, invoking shell becomes lead |
| `spawn <team> <role>@<cwd>[:<color>]` | Spawn claude.exe teammate via `maw tile --path --cmd`; canonical TeamCreate flags incl. `--session-id` for deterministic UUIDs |
| `ls [<team>]` | All teams, or one team's members + inbox counts |
| `msg <team> <role> "<text>" [--by <sender>]` | Append envelope to `inboxes/<role>.json`. Mimics SendMessage. Default sender: `"shell"` |
| `shutdown <team> <role>` | Append `{"type":"shutdown_request"}` to inbox |
| `kill <team> <role>` | Force-kill teammate |
| `delete <team>` | Remove team |
| `help` | Inline docs |

**Why this exists in parallel to `maw team`**: `maw team` is the full reincarnation engine and needs Claude tools to call TeamCreate properly. `maw team-agent` is the shell-only escape hatch — you can drive TeamCreate-shaped teams from a plain bash script without needing a Claude Code session to be live. Use cases: cron-driven team spawns, CI bootstraps, external orchestrators.

## Architectural notes

### Six empirical seams (from `/team-tile-demo` + vault traces)

Where team features cross boundaries they don't fully own:

1. **`/maw-workon` workers ↔ team substrate** — workon spawns a pane but doesn't register it as a team member until something at L2/L3 binds it.
2. **GitHub issues ↔ teams** — `maw assign` creates the link, but issue closure doesn't auto-cleanup the team.
3. **XML render seam** — `SendMessage` payloads get wrapped as `<teammate-message>` in the receiver's LLM context. The wrap is one-way.
4. **Cross-session boundary auth** — federation tokens (`~/.config/maw/maw.config.json`) authenticate cross-machine, but in-session teams have no auth.
5. **`maw ls` registry blindness** — L2 teams (`/team-agents`) are invisible to L1 `maw ls`. Two registries, no sync.
6. **`shutdown_approved` ≠ process kill** — ACK chain confirms intent; actual pane termination needs `/team-down` or `maw kill`.

### Heartbeat protocol (`/team-agents` only)

`/team-agents` enforces a structured liveness signal. Every long-running teammate MUST emit one of:

- `PROGRESS` — still working, here's what's done
- `STUCK` — can't proceed without input
- `DONE` — task complete
- `ABORT` — giving up

The auto-memory rule (`feedback_team_agents_heartbeat_mandatory.md`): *"for any long Bash work, the prompt MUST say 'after EVERY Bash, next tool MUST be SendMessage'."* Without that, agents batch and go silent for 20+ minutes.

`maw team` has no equivalent — its members report at will via `maw team send` or `maw hey`.

### Federation primitives

| Primitive | Endpoint / verb | Purpose |
|---|---|---|
| HTTP API (port 3456) | `/api/send`, `/api/team*`, `/api/agent*`, `/api/peer*` | Cross-machine team operations |
| Auth tokens | `~/.config/maw/maw.config.json` | Symmetric, bidirectional |
| `oracle-invite` | `maw team oracle-invite` | Invite cross-machine oracle to team |
| `maw hey` over federation | resolves `node:oracle` or `node:session:window` | Direct message routing |
| `maw notify` over federation | `--inbox` always, no pane inject | Routine push (#1882) |
| `maw broadcast` over federation | fleet-wide | Status updates |

## Sibling repos (cross-cuts the maw-js boundary)

Coordination infrastructure that lives outside maw-js but depends on it:

| Repo | Purpose |
|---|---|
| `Soul-Brews-Studio/multi-agent-workflow-kit` | Python + bash bootstrapper; same `maw hey` + worktree pattern, but driveable from CI |
| `Soul-Brews-Studio/maw-cross-team-queue` | Cross-team coordination — unified inbox semantics |
| `Soul-Brews-Studio/team-spawn-oracle` | Demo/template oracle for team patterns |
| `Soul-Brews-Studio/oracle-agent` | Agent harness library |
| `Soul-Brews-Studio/000-multi-agents-workshop` | Educational walkthrough |
| `Soul-Brews-Studio/maw-plugin-registry` | Plugin discovery + `/agents/` directory (incl. `maw buddy` scaffold) |
| `Soul-Brews-Studio/arra-oracle-skills-cli` | Earlier home of `/team-down` / killshot; lead-kill bug fix lives here |

## Status board

### Active
- All maw-js plugins listed above
- All Claude Code APIs (TeamCreate/SendMessage/TaskCreate/TeamDelete)
- All user skills above except `killshot`
- Federation HTTP API + auth

### Deprecated
- `killshot` (subcommand of `/team-agents`) — replaced by `/team-down` after arra#411 lead-kill bug

### Scaffold (shipped infrastructure, not yet user-facing)
- `maw buddy` plugin — lives in `maw-plugin-registry/plugins/buddy/`, has `buildBuddyPriming()` + `cmdBuddy()` impl. Tests + registry registration pending. Tracking: maw-plugin-registry #94.

### Design-only / proposed
- `maw resonance capture` — wraps `maw hey` with explicit attribution chain + vault-write. Pattern observed across 3 cross-oracle resonance exchanges (Mali↔Odin 2026-05-24 × 2, mawjs→Odin 2026-05-26).
- `maw ask` — conversational CLI sibling to buddy family. Currently only `omx ask <cli>` exists.

## Where things live on disk

```
# L2 team registry
~/.claude/teams/<name>/config.json
~/.claude/teams/<name>/inboxes/<role>.json
~/.claude/teams/<name>/tasks.json

# L1 plugin sources (canonical)
src/commands/plugins/team/
src/commands/plugins/tile/
src/commands/plugins/swarm/
src/commands/plugins/federation/
src/commands/plugins/discover/
src/commands/plugins/fleet/
src/commands/plugins/oracle/
src/commands/plugins/pane/
src/commands/plugins/transport/
src/commands/plugins/channel/
src/commands/plugins/cli/

# L1 plugin sources (vendor mpr-plugins)
src/vendor/mpr-plugins/team-agent/
src/vendor/mpr-plugins/broadcast/
src/vendor/mpr-plugins/avengers/
src/vendor/mpr-plugins/mega/
src/vendor/mpr-plugins/reunion/
src/vendor/mpr-plugins/pair/
src/vendor/mpr-plugins/cross-team-queue/
src/vendor/mpr-plugins/scope/
src/vendor/mpr-plugins/tag/
src/vendor/mpr-plugins/take/
src/vendor/mpr-plugins/tab/
src/vendor/mpr-plugins/oracle-workon/
... (85+ vendored plugins total)

# L3 user skills (Claude Code)
~/.claude/skills/team-agents/
~/.claude/skills/team-agent/         # singular wizard
~/.claude/skills/team-tile-spawn/
~/.claude/skills/team-tile-demo/
~/.claude/skills/team-down/
~/.claude/skills/full-auto-long-demo/
~/.claude/skills/tile/
~/.claude/skills/maw-workon/
~/.claude/skills/oracle-workon/
~/.claude/skills/forward-bg/

# L1 alias resolution
src/cli/top-aliases.ts               # bring, ls, layout, wake, awake, new, attach
src/cli/route-comm.ts                # hey, send, notify, peek interception
src/cli/dispatch.ts                  # plugin lookup

# Federation
~/.config/maw/maw.config.json        # auth tokens
HTTP port 3456                       # API endpoints
```

## Known issues / open gaps

1. **`maw ls` registry blindness** — L2 teams (`/team-agents`) invisible to L1 `maw ls`. Two registries, no sync.
2. **Naming collision** — `/team-agent` (singular wizard for maw plugin) vs `/team-agents` (plural Claude skill) — easy to mistype.
3. **`maw buddy` incomplete** — Scaffold exists in `maw-plugin-registry/plugins/buddy/`, fixtures + tests + registry registration pending. See maw-plugin-registry#94.
4. **Cross-node buddy blocked** — Depends on #1814 (identity collision) fix.
5. **No `--parent-session-id` flag on most spawn paths** — spawned agents don't auto-discover their spawner. Workaround: pass via env or system prompt. (`maw team-agent spawn` does have `--session-id` and `--parent`.)
6. **19 teams from 2026-05-14 marathon lost** — Oracle indexer embeddings backend failed; teams exist only in session JSONLs.

## Historical peaks

- **2026-05-14** — 26 concurrent teams in one session (compound shipping pattern). Wave pattern: scouts → fixers. Domain-narrowed parallelism wins.
- **2026-05-20** — Buddy-mom-demo validates cross-engine pairing (Engine A spec ↔ Engine B impl over shared worktree + `maw hey`).
- **2026-05-26 → 2026-05-27** — modtanoii cross-community PR #1917 cherry-picked into alpha.1057 (wake race fix). Demonstrated "ego subordinate to quality" team contribution pattern.

## Further reading

- Source-of-truth long-form (vault): `mawjs-oracle/ψ/writing/maw-team-features-book.md` — 4,015-word field guide with chapters per layer
- Source trace: `mawjs-oracle/ψ/memory/traces/2026-05-27/0710_team-feature.md`
- Architecture deep-dive: `mawjs-oracle/ψ/memory/traces/2026-05-15/1055_team-vs-tile-comms-architecture.md`
- Cool patterns archive: `mawjs-oracle/ψ/memory/traces/2026-05-13/0224_maw-team-cool-things.md`
- "When You Don't Need a Team, You Need a Tile" (blog): `mawjs-oracle/ψ/inbox/2026-05-15_blog-tile-as-team.md`
- Buddy design: `mawjs-oracle/ψ/memory/traces/2026-05-20/0554_mawjs-buddy.md`
- 4-node mesh federation retro: `mawjs-oracle/ψ/memory/retrospectives/2026-03/30/00.06_four-node-mesh-federation.md`

---

*Last updated 2026-05-27. Built from a deep enumeration pass across maw-js + mawjs-oracle vault + user skills + 6 sibling repos. If a verb is missing from this doc, run `maw <verb> --help` for ground truth — the binary is the source-of-truth.*
