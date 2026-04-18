# `maw bud --from-repo` — design

Issue: #588
Status: scaffold-only (this PR) → full injection lands in follow-up PRs.

## Problem

Today `maw bud <name>` creates a brand-new repo (`<name>-oracle`) under the
configured GitHub org and initialises oracle scaffolding inside it (ψ/,
CLAUDE.md, fleet config). There is no supported way to take an **existing**
repository and "oracle-ise" it in place — to add ψ/, append to its CLAUDE.md,
and drop the minimal `.claude/` hooks without disturbing source code.

`--from-repo <target>` injects the oracle-side scaffolding into a target repo.

## Flag shape

```
maw bud --from-repo <path-or-url> --stem <stem> [--pr] [--dry-run]
```

- `--from-repo <target>` — the repo to inject into. Accepts:
  - a local absolute path to a checked-out repo
  - `org/repo` slug (resolved via `ghq get`, see `shared/wake-target`)
  - a full git URL (`https://github.com/...` or `git@github.com:...`)
- `--stem <stem>` — the oracle stem (no `-oracle` suffix; the bud naming
  guard in `impl.ts` already rejects trailing `-oracle`). Used for CLAUDE.md
  identity block + fleet entry name in later PRs.
- `--pr` — instead of committing to the default branch, create a branch
  `oracle-scaffold` and open a PR. **Not implemented in this PR.**
- `--dry-run` — print the injection plan (list of files to add / append)
  and exit without writing. **Implemented in this PR.**

`--stem` is required (we don't try to infer from repo path, because the
"arra-oracle-v3 → arra-oracle-v3-oracle" bud-naming pitfall applies here
too — user must state the stem explicitly). If omitted, we error with the
existing naming-guard message style.

## What gets injected (exact list)

Four groups, in order:

1. **`ψ/` vault directory** — same structure as `bud-init.ts::initVault`:
   ```
   ψ/memory/learnings/
   ψ/memory/retrospectives/
   ψ/memory/traces/
   ψ/memory/resonance/
   ψ/memory/collaborations/
   ψ/inbox/
   ψ/outbox/
   ψ/plans/
   ```
   All empty — no seed content. (Follow-up PR: optional `--seed` from a parent.)

2. **`CLAUDE.md`** — if absent, write the full `generateClaudeMd` template
   (identity + Rule 6). If present, **append** an `## Oracle scaffolding`
   section with Rule 6 + lineage pointer. We never overwrite a host repo's
   CLAUDE.md — that is a collision rule below.

3. **`.claude/` minimal** — just enough for skills to resolve:
   ```
   .claude/settings.local.json   (empty JSON object)
   ```
   We deliberately skip hooks / commands / MCP wiring in this PR. Follow-up
   PR can add a `.claude/hooks/` directory for rtk + oraclenet.

4. **Fleet entry** — reuse `configureFleet` from `bud-init.ts`, pointing
   `windows[0].repo` at the target repo slug. Parent lineage is optional
   here (a host-repo oracle may be a root-style oracle with no parent).
   **Not written in this PR** — the scaffold module only returns the plan.

## Collision rules

Hard stops (abort before writing anything):

- `ψ/` already exists at target → `error: ψ/ already present — looks like
  an existing oracle repo. Use maw soul-sync or maw wake.`
- Target path is not a git repo (`.git` absent and not a valid work-tree)
  → error. (URL targets are cloned via `ghq` first, so they always land
  in a git repo.)
- `--stem` ends with `-oracle` → reuse the existing runtime guard message
  from `impl.ts`.

Soft merges:

- `CLAUDE.md` exists → append, never overwrite. The appended block is
  fenced with an HTML comment marker (`<!-- oracle-scaffold: begin -->`)
  so re-running the injector can detect idempotency.
- `.claude/settings.local.json` exists → leave it alone. Only create if
  absent.
- Fleet entry already exists for this stem → reuse it (existing
  `configureFleet` already handles idempotency).

## Lifecycle — which bud steps run when `--from-repo`

`maw bud` today runs eight steps (see `impl.ts::cmdBud`):

| # | Step                      | --from-repo runs? | Why |
|---|---------------------------|-------------------|-----|
| 1 | `ensureBudRepo` (create gh repo + ghq get) | **skip** | target already exists; we only need a local checkout |
| 2 | `initVault` (ψ/)          | **run** | core of the injection |
| 3 | `generateClaudeMd`        | **run (modified)** | append if file exists; write full if not |
| 4 | `configureFleet`          | run — follow-up PR | fleet needs the target slug + stem |
| 4.5 | `writeBirthNote` (opt-in on `--note`) | run — follow-up PR | |
| 5 | soul-sync `--seed`        | **skip** | out of scope for injection (follow-up) |
| 6 | initial commit + push     | **skip** | host repo owner decides when/how to commit |
| 7 | parent `sync_peers` update | run — follow-up PR | only if `--from` is also given |
| 8 | `cmdWake`                 | **skip** | injection is not a session — user runs `maw wake` manually |

Identity creation: same as regular bud (name must pass `assertValidOracleName`).
Issue creation: no — existing `--issue` is for fetching a prompt on wake; not
relevant here.

## Where the code lives

```
src/commands/plugins/bud/
  index.ts          # add --from-repo + --stem + --pr to parseFlags spec
  impl.ts           # branch early: if opts.fromRepo, call cmdBudFromRepo
  from-repo.ts      # NEW — planFromRepoInjection(opts) → InjectionPlan
                    #       cmdBudFromRepo(opts) → orchestrator (dry-run only this PR)
  types.ts          # NEW — FromRepoOpts + InjectionPlan
  from-repo.test.ts # NEW — parser wiring + plan assertions
```

`from-repo.ts` stays ≤200 LOC. If it grows in follow-ups, split the
actual-write path into `from-repo-apply.ts` to keep the planner pure.

## This PR's ship criterion

- `maw bud --from-repo <path> --stem x --dry-run` prints the injection
  plan and exits 0 without touching the target.
- `maw bud --from-repo <path> --stem x` (no `--dry-run`) exits non-zero
  with `not yet implemented — see #588`. No partial writes ever.
- Types exported so the follow-up PR can `import { FromRepoOpts } from "./types"`.
- Tests cover: parser routes `--from-repo` to the new module; planner
  returns the expected file list for a clean target; collision on
  pre-existing ψ/ is reported (planner-level — doesn't need to write).

## Explicit TODO — not in this PR

1. Actually writing ψ/ + CLAUDE.md append + `.claude/settings.local.json`.
2. URL / `org/repo` resolution via `ensureCloned` (only local paths in dry-run).
3. `--pr` branch-and-PR path.
4. Fleet entry creation (step 4 of the lifecycle).
5. Idempotency marker detection on re-run.
6. Optional `--from <parent>` for lineage in the injected CLAUDE.md.
