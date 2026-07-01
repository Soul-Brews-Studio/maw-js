# ADR-0001 (company): Reorganize `home` / `worklog` / `task` CLI under `maw company`, and make `task` MCP-first for agents

**Status**: Proposed (awaiting eq3 + Tony review)
**Date**: 2026-07-01
**Tracking**: kobo-20 (epic: cli-reorg) · request eq3-017
**Children**: kobo-21 (MCP), kobo-22 (home), kobo-23 (worklog), kobo-24 (task + forcing)
**Author**: meganechan:patchwork

## Context

Three top-level `maw` commands are conceptually **owned by a company** but live at the fleet root:

- `maw home <init|commit>` — Company Home git repo (ADR 0002 task-system). Home *is* per-company; `maw home` reads the company from config/positional.
- `maw watch <log|inject|sync|setup-hooks|claim|release>` — the worklog activity plane. Its scope is the company (its members), decided by `companyOfOracle` (see the eq3-014 fix). The name "watch" also poorly describes what it is: a **worklog**.
- `maw task <add|ls|start|claim|review|pr|done|block|unblock|archive>` — the company task board (ADR 0001/0003 task-system). Cards live under `companies/<c>/tasks/`.

Two problems:

1. **Namespace drift.** These read as fleet-global verbs, but each is a company-scoped concern. New oracles have to learn that `task`/`watch`/`home` are "really" company subsystems.
2. **Agents reach for `bash maw task`.** patchwork (and the shared model tendency) habitually shells `maw task …`. Tony wants agents to use the **MCP tool** for task ops (structured, faster, no text-parse token cost — the same rule already applied to `hey`/`reply`/`inbox`/`ls`). Today there is no `maw_task` MCP tool, so bash is the *only* path — the habit is forced, not chosen.

eq3 + Tony grilled this and decided: **hard-move** the three commands under `maw company`, **rename** `watch → worklog`, and add a **`maw_task` MCP tool** so the agent path is MCP and the CLI is human/debug-only.

### Key de-risking finding (why this is safer than it looks)

The board/worklog **engine does not depend on CLI command names**. Verified:

- **pr-watch** (`src/core/worklog/pr-watch.ts:20,89,169`) calls core functions directly — `appendWorklog`, `findTaskByPr`, `completeTask`, `prOpenedReview`. It never shells `maw watch` / `maw task`. (The `maw watch log/sync` mention at `pr-watch.ts:4` is a **doc comment**.)
- **auto-create** (`src/core/tasks/auto-create.ts`) is core, invoked in-process; comments reference `maw task` but the code calls the store.
- **Hooks** (`src/core/worklog/hook-setup.ts`) are base64-embedded shell scripts that talk to the **server over HTTP** (`curl …/api/feed`, `…/api/worklog?oracle=`). They contain **no runtime `maw watch` call** — only comments ("Provisioned by `maw watch setup-hooks`").
- **Banner** text `"📋 maw watch — company activity"` (`src/core/worklog/slice.ts:28`) is a cosmetic string literal.

⇒ The true breaking surface is **only the human/agent-typed CLI entry points + docs/CLAUDE.md/RTK references**. Nothing in the auto-create → pr-watch → board loop breaks from a CLI rename. This is what makes an atomic caller-sweep tractable.

## Decision

### D1. Dispatch by delegation, not by moving code

`company/index.ts` already dispatches subcommands via an `if (sub === "…")` chain (`create`, `add-dept`, `sync`, `hooks`, `attach`, …). Add three new groups that **delegate to the existing handlers**:

```
maw company home    <verb…>  → home plugin handler(args.slice(1))
maw company worklog <verb…>  → (renamed) watch plugin handler(args.slice(1))
maw company task    <verb…>  → task plugin handler(args.slice(1))
```

Keep each handler in its own module and keep the core logic in `src/core/{home,worklog,tasks}/`. The company plugin imports the sub-handlers and forwards `args`. Rationale: least churn, preserves the existing standalone-test boundaries, no logic duplication (constraint: "reuse core, don't duplicate").

### D2. Hard cut the top-level commands (per Tony), sweep callers atomically

Unregister the top-level `home` / `watch` / `task` CLI commands (remove/repoint their `plugin.json` `cli.command`). No permanent alias. **But** — a hard cut across a fleet where other oracles still run old CLAUDE.md/global config means those agents type `maw task …` and get "unknown command" until their config is swept. See **Open Question OQ1** for the mitigation choice.

### D3. `maw_task` MCP tool, action-param style, shipped first (non-breaking)

Mirror `maw_inbox`: one tool, an `action` enum covering **all** verbs 1:1 with the CLI (`add|ls|start|claim|review|done|pr|block|unblock|archive`), plus the optional params each needs. Implement as a pure `taskArgs(input)` argv-builder in `mcp/tools.ts` (unit-testable, like `inboxArgs`/`deptArgs`) + a `registerTool` in `mcp/server.ts`. It **spawns the CLI** (`runMaw`) — so it reuses all task logic with zero duplication and inherits identity/Rule-6 signing.

**Argv target across the rollout:** in kobo-21 `taskArgs` targets the surface that exists then — `maw task <verb>`. In kobo-24 (the atomic task move) the same builder flips to `maw company task <verb>` **in the same PR** that adds the new command and removes the old, so every PR is internally consistent and shippable.

### D4. MCP-forcing is a rule now, a hook later

In kobo-24, CLAUDE.md states: **agents do task ops via the `maw_task` MCP tool only — do not `bash maw company task`** (CLI is human/debug). The optional PreToolUse warn-hook is **deferred to a follow-up** (eq3 marked it optional; a rule + the fact that MCP is now available is enough to change the habit; a hook adds fleet-config surface we can add later if the habit persists).

### D5. Out of scope (explicit)

**Home authorization** (own-company + manager gate — "not everyone can `home init`") is a **separate follow-up**, per Tony ("เมนูก่อน" — menu move first). This ADR only moves the menu; it does not add authz.

## Rollout order (atomic per card, 1 PR each)

```
kobo-21  MCP maw_task            ── non-breaking, ship FIRST
                                    (targets current `maw task`; gives agents the MCP path
                                     before the CLI moves, so no window without a task path)
   │
   ├── kobo-22  maw company home     ── independent, low blast (few callers: cron/clock-out `home commit`)
   ├── kobo-23  maw company worklog  ── independent; rename watch→worklog + caller-sweep (cosmetic + provisioning)
   │
   └── kobo-24  maw company task     ── LAST; depends on kobo-21 (MCP must exist first)
                                        atomic: add `company task` + remove top-level `task`
                                        + flip taskArgs → `company task` + MCP-forcing rule + caller-sweep
```

22 and 23 can land in parallel (disjoint files). 24 is last and depends on 21 so the agent task path (MCP) exists before the human path moves.

## Caller-sweep inventory (what each PR must touch)

Grounded in grep; each is inside the atomic PR that renames its target.

| Ref | File | kind | Card |
|-----|------|------|------|
| banner literal `📋 maw watch` | `src/core/worklog/slice.ts:28` | cosmetic string | 23 |
| pr-watch doc `maw watch log/sync` | `src/core/worklog/pr-watch.ts:4` | comment | 23 |
| hook comments + `setup-hooks` provisioning name | `src/core/worklog/hook-setup.ts` | comments + generated cmd name | 23 |
| store/auto-create doc mentions | `src/core/{tasks/store.ts,tasks/auto-create.ts,worklog/store.ts,home/store.ts}` | comments | 22/23/24 |
| view hint `maw task add … --body` | `src/views/company.ts:174` | UI string | 24 |
| MCP `taskArgs` argv | `src/vendor/mpr-plugins/mcp/tools.ts` | code (flip in 24) | 24 |
| global `CLAUDE.md` + `RTK.md` task/watch refs | (fleet config, outside repo) | docs sweep | 23/24 |
| patchwork memory referencing `maw watch`/`maw task` | (oracle memory) | docs sweep | 23/24 |

## Test / CI-gate obligations (constraint)

Every vendor-plugin change requires updating its `test/isolated/plugin-<name>-standalone.test.ts` (the #2316 touch-gate). All four exist today.

- **kobo-21**: `mcp` is a vendor plugin → touch `plugin-mcp-standalone.test.ts` (verify exists) + unit test `taskArgs` for all 10 verbs (pure fn, like `inboxArgs`).
- **kobo-22**: touches `home` + `company` dirs → update `plugin-home-standalone.test.ts` + `plugin-company-standalone.test.ts`.
- **kobo-23**: touches `watch` (→worklog) + `company` → update both standalone tests.
- **kobo-24**: touches `task` + `company` + `mcp` → update all three.
- **Board-safety regression**: 24 must include a test asserting auto-create → pr-watch still drives a card to review/done through **core** (proving the CLI move didn't break the engine).

## Consequences

**Positive:** clean company namespace; agents get a structured MCP task path and a rule that matches Tony's intent; the engine coupling audit is now documented (future renames are cheap). **Negative / risk:** a hard cut is fleet-breaking for un-swept configs → OQ1. Four coordinated PRs + a deploy + a fleet-config sweep is real coordination cost. **Neutral:** `maw company task` is more to type for humans — acceptable, since the agent path is MCP and CLI is debug-only.

## Open questions for eq3 + Tony

- **OQ1 (the real risk): hard cut vs. deprecation shim vs. sequenced sweep.** A hard cut means any oracle still on old config gets "unknown command" for `maw task`/`maw watch`/`maw home` until swept. Options:
  - **(a) Hard cut + sequence the fleet CLAUDE.md/global sweep to land *before* the maw-js deploy that removes the commands.** Cleanest end-state, but requires the docs sweep to ship first and every oracle to reload config before deploy.
  - **(b) Thin deprecation shim**: keep the old top-level names for one release, each printing `"moved → maw company X"` and forwarding. Zero breakage, self-documenting, removed in a later PR. Costs a temporary alias (mild tension with the "hard move" instruction).
  - **(c) Hard cut, accept a short broken window**, sweep configs right after deploy.
  - *patchwork leans (b)* — safest for a live fleet, and the shim is a ~10-line forward that we delete next cycle. But Tony said "hard move," so this is Tony's call.
- **OQ2**: `maw company worklog` verb list — keep all of `log|inject|sync|setup-hooks|claim|release` verbatim, or is any of them itself dead/internal and worth dropping in the same move?
- **OQ3**: ADR home — I placed this at `docs/company/0001-…`. Confirm that's where the company-domain ADRs should live (the task-system "ADR 0001-0003" are referenced in code but have no doc files; if they should be back-filled here too, say so).
