# Plugin Audit (Phase 0 of #640)

Generated 2026-04-28 by mawjs-oracle@white.

> Phase 0 deliverable for the lean-core epic (#640). Classifies every plugin
> currently shipped in `src/commands/plugins/` into **core / standard / extra**
> tiers, records each plugin's coupling profile (internal-import count) and
> last-modified date, and recommends an extraction verdict.
>
> **Docs only — zero code changes.** This audit unblocks Phase 1 (profile
> loader) and Phases 3+ (per-plugin extractions).

## Methodology

1. `ls src/commands/plugins/` → 71 entries (70 with valid `plugin.json`,
   plus `hey-test/` which is a stub: no `plugin.json`, last touched
   2026-04-13).
2. For each plugin: read `plugin.json` (`name`, `weight`, declared API),
   inventory internal `import` paths via `grep -rhoE "from ['\"]\\.\\.[^'\"]+['\"]"`.
3. Last-modified inferred from `git log -1 --format=%cs -- <plugin-dir>`.
4. Tier rules (per #640 scoping comment):
   - **core** — every install needs this. Federation primitives, plugin loader,
     config, identity, basic dispatch.
   - **standard** — most installs benefit. Health/lifecycle and the canonical
     send/run/peek loop.
   - **extra** — opt-in. Specialized workflows (oracle/team/pair/bud/UI/etc).
5. Extract verdict:
   - **clean** — only depends on `plugin/types` + `sdk` (or nothing internal);
     trivial to lift into a community repo.
   - **tangled** — reaches into `core/`, `cli/`, peer plugins, or shared
     fleet helpers; needs an SDK widening before extraction.
   - **maintenance-only** — still needed in core indefinitely; rarely changes.
   - **stub** — incomplete, not shipped.
6. Conservative tier assignment: when in doubt → **standard**.
7. Already-extracted reference: `shellenv` (#816, #848), `rename` (#859) —
   both shipped from in-tree to community repo with the SDK contract that
   landed in #827 (`src/cli/plugin-bootstrap.ts`).

## Summary

- **Total plugins (in-tree):** 71 entries (70 with `plugin.json` + `hey-test`
  stub)
- **Core:** 8
- **Standard:** 13
- **Extra:** 49
- **Stub / not shipping:** 1 (`hey-test`)
- **Already extracted (community):** 2 — `shellenv` (#816, #848), `rename`
  (#859). Not in this table.

Note on the #640 spec list: several names listed as "core candidates"
(`cli`, `parse-args`, `loader`, `config`, `serve`, `info`, `hey`, `help`)
are NOT plugins today — they live in `src/cli/`, `src/config/`, and the
top-level command surface. They are core *infrastructure*, already lean,
and out of scope for this audit. Likewise `bootstrap` lives in
`src/cli/plugin-bootstrap.ts` (#827).

## Detailed table

| Plugin | Tier | Verdict | Internal deps | Last mod | Notes |
|--------|------|---------|---------------|----------|-------|
| about | extra | clean | 2 | 2026-04-16 | Identity blurb. SDK-only. Easy lift. |
| archive | extra | tangled | 5 | 2026-04-24 | Reaches into `soul-sync/impl` + `shared/fleet-load`. |
| artifact-manager | extra | clean | 1 | 2026-04-13 | Already self-contained (only `plugin/types`). Prime extraction candidate. |
| assign | extra | tangled | 3 | 2026-04-16 | Cross-team-queue cousin. Move with that bundle. |
| avengers | extra | clean | 2 | 2026-04-16 | Specialty workflow. Easy lift. |
| broadcast | extra | clean | 2 | 2026-04-16 | Federation broadcast helper. SDK-only. |
| bud | extra | tangled | 15 | 2026-04-28 | Heaviest plugin. Reaches `core/fleet/*`, `core/matcher`, `core/paths`, `cli/parse-args`, `peers/store`, `shared/fleet-load`, `shared/wake*`. Needs SDK widening before extraction. Active. |
| capture | extra | tangled | 4 | 2026-04-16 | Workflow capture. Couples to fleet. |
| check | extra | clean | 2 | 2026-04-16 | Verifier. Light deps. |
| cleanup | extra | clean | 2 | 2026-04-16 | Janitor. Light. |
| completions | extra | clean | 2 | 2026-04-16 | Shell completion emitter. Sibling to extracted `shellenv`. |
| consent | extra | tangled | 3 | 2026-04-19 | Touches `core/consent`. Move with consent infra. |
| contacts | extra | tangled | 3 | 2026-04-16 | Persistent contact registry. Touches schemas. |
| costs | extra | tangled | 5 | 2026-04-20 | Token/cost reporter. Multi-source. |
| cross-team-queue | extra | clean | 2 | 2026-04-19 | Queue plumbing. Light coupling. |
| demo | extra | clean | 3 | 2026-04-18 | Demo runner. Easy lift. |
| doctor | standard | tangled | 6 | 2026-04-29 | Reaches `peers/*` + `shared/fleet-doctor-fixer`. Stays close to core. |
| done | extra | tangled | 6 | 2026-04-24 | Touches `reunion/impl`, `soul-sync/impl`. Workflow-specific. |
| federation | core | tangled | 1 | 2026-04-17 | Federation primitive. Stays in core; light internal dep. |
| find | extra | tangled | 4 | 2026-04-24 | Cross-fleet search. Touches ghq-root + fleet-load. |
| fleet | extra | tangled | 6 | 2026-04-24 | Fleet inspector. Heavy core ties — keep with fleet primitives. |
| health | standard | clean | 3 | 2026-04-28 | SDK + config only. Maintenance plugin. |
| hey-test | — | stub | 1 | 2026-04-13 | No `plugin.json`. Drop or convert to test fixture. |
| inbox | core | clean | 2 | 2026-04-29 | Schemas + types only. Daily-driver primitive. Stays core. |
| incubate | extra | clean | 1 | 2026-04-18 | Repo-scaffolding. Light. |
| init | extra | tangled | 5 | 2026-04-24 | First-run wizard. Touches plugin/lock + config/types. Maintenance-only after extraction. |
| kill | extra | tangled | 4 | 2026-04-16 | Process control. Fleet-coupled. |
| learn | extra | clean | 1 | 2026-04-18 | Codebase explorer. Light. |
| locate | extra | tangled | 7 | 2026-04-17 | Resolver. Multi-core touchpoints. |
| ls | core | clean | 2 | 2026-04-16 | Daily-driver. Comm + types only. Stays core. |
| mega | extra | clean | 2 | 2026-04-16 | Multi-action runner. |
| on | extra | clean | 1 | 2026-04-16 | Per-target executor. |
| oracle | extra | tangled | 10 | 2026-04-29 | Oracle skill manager. Heavy core ties. Active development. Defer extraction. |
| overview | extra | tangled | 3 | 2026-04-17 | Status dashboard. |
| pair | extra | tangled | 3 | 2026-04-18 | Pair-programming workflow. |
| panes | extra | tangled | 4 | 2026-04-16 | tmux pane manager. Fleet-coupled. |
| peek | standard | clean | 2 | 2026-04-16 | Federation read primitive. Comm + types. |
| peers | core | clean | 1 | 2026-04-28 | Federation peer registry. Types only. Stays core. |
| ping | extra | tangled | 3 | 2026-04-16 | Liveness check. |
| plugin | core | tangled | 11 | 2026-04-29 | Plugin manager itself (`maw plugin install/lock/etc`). Maintenance-only — must stay core. |
| pr | extra | clean | 2 | 2026-04-18 | GitHub PR helper. Light. |
| project | extra | clean | 1 | 2026-04-18 | Project tracker. Light. |
| pulse | extra | clean | 2 | 2026-04-16 | Heartbeat. Light. |
| restart | extra | tangled | 4 | 2026-04-18 | Lifecycle. Fleet-coupled. |
| resume | extra | clean | 2 | 2026-04-29 | SDK + types only. |
| reunion | extra | clean | 2 | 2026-04-17 | SDK + types only. |
| run | standard | clean | 4 | 2026-04-28 | SDK + comm-send. Canonical send-loop primitive. |
| scope | core | clean | 2 | 2026-04-28 | Identity scope (`<node>:<agent>`). Schemas + types. Stays core. |
| send | standard | clean | 4 | 2026-04-28 | Messaging primitive. Comm-send. |
| send-enter | standard | clean | 4 | 2026-04-24 | Send + carriage return convenience. |
| session | extra | clean | 1 | 2026-04-15 | Session metadata. Light. |
| signals | extra | tangled | 3 | 2026-04-18 | Signal/event bus. |
| sleep | standard | clean | 3 | 2026-04-16 | Lifecycle. Sibling to wake. |
| soul-sync | extra | tangled | 5 | 2026-04-29 | Memory transfer. Active. |
| split | extra | tangled | 5 | 2026-04-18 | Workspace split. Fleet-coupled. |
| stop | extra | clean | 2 | 2026-04-16 | Lifecycle. Light. |
| tab | extra | tangled | 4 | 2026-04-16 | tmux tab. Fleet-coupled. |
| tag | extra | tangled | 4 | 2026-04-16 | Tagging. |
| take | extra | tangled | 3 | 2026-04-16 | Hand-off. |
| talk-to | extra | tangled | 4 | 2026-04-28 | Inter-agent thread starter. |
| team | extra | tangled | 8 | 2026-04-26 | Team coordination. Heavy core ties. Active. |
| tmux | extra | tangled | 5 | 2026-04-17 | tmux primitive. Maintenance-only — keeps fleet alive. Reconsider if extracted with fleet bundle. |
| transport | extra | clean | 2 | 2026-04-16 | Transport switcher. Light. |
| triggers | extra | clean | 1 | 2026-04-16 | Trigger registry. Types only. |
| trust | core | clean | 1 | 2026-04-29 | Trust ledger. Schemas only. Stays core (security boundary). |
| ui | extra | tangled | 4 | 2026-04-17 | UI launcher. |
| view | standard | tangled | 6 | 2026-04-28 | Cross-fleet viewer. Touches `core/fleet/audit`, `init/prompts`. |
| wake | standard | clean | 2 | 2026-04-28 | Lifecycle. SDK + parse-args. |
| whoami | extra | tangled | 3 | 2026-04-16 | Identity reporter. |
| workon | extra | tangled | 6 | 2026-04-16 | Repo-context wake. Heavy ties. |
| workspace | extra | tangled | 3 | 2026-04-16 | Workspace metadata. |
| zoom | extra | tangled | 4 | 2026-04-16 | tmux zoom. Fleet-coupled. |

## Tier counts summary

| Tier | Count | Verdict mix |
|------|-------|-------------|
| core | 8 | 6 clean / 2 tangled (`federation`, `plugin`) |
| standard | 13 | 8 clean / 5 tangled |
| extra | 49 | 21 clean / 28 tangled |
| stub | 1 | `hey-test` (drop or convert) |
| **total** | **71** | **35 clean / 35 tangled / 1 stub** |

Half of the tree is **clean** — mostly SDK + `plugin/types` only. These are
the cheapest extractions and the fastest path to a lean core.

## Extraction roadmap

Move in dependency order — clean first, tangled later, maintenance-only never.

### Wave 1 — clean extra plugins (~21 plugins, low risk)

Same shape as `shellenv` (#816, #848) and `rename` (#859). Each lifts to
`maw-plugin-<name>` with the existing SDK contract. No core changes needed.

Priority order (fewest deps first → biggest wins):

1. `artifact-manager` (1 dep) — already isolated.
2. `learn`, `on`, `project`, `triggers`, `incubate`, `session` (1 dep each).
3. `about`, `avengers`, `broadcast`, `check`, `cleanup`, `completions`,
   `cross-team-queue`, `mega`, `pulse`, `stop`, `transport`, `pr`,
   `resume`, `reunion` (2 deps each).
4. `demo` (3 deps).

Outcome: ~30% of the tree extracted with no SDK widening.

### Wave 2 — clean standard plugins (8, behind a profile flag)

`health`, `peek`, `run`, `send`, `send-enter`, `sleep`, `wake` ship in the
default `standard` profile but live in the registry. Bundle as
`@maw/standard`.

### Wave 3 — tangled extra plugins (~28, requires SDK work)

These reach into `core/fleet`, `core/matcher`, `core/ghq`, `shared/wake*`,
`shared/fleet-load`. Before extraction:

- Land #626 (SDK exports complete) for: `bud`, `oracle`, `team`,
  `soul-sync`, `done`, `archive`, `find`, `fleet`, `locate`, `view`,
  `restart`, `workon`, `split`, `tmux`, `tab`, `panes`, `zoom`, `kill`,
  `init`.
- Then extract by workflow bundle:
  - **fleet bundle**: `fleet`, `tmux`, `tab`, `panes`, `zoom`, `restart`,
    `kill`, `split`, `workon` — ship as one community plugin set.
  - **oracle/lineage bundle**: `bud`, `oracle`, `soul-sync`, `done`,
    `reunion`, `archive`, `find` — second community set.
  - **team/queue bundle**: `team`, `pair`, `assign`, `cross-team-queue`,
    `take`, `talk-to`, `signals`, `consent`, `contacts`, `capture`,
    `costs` — third set.

### Wave 4 — keep in core forever (maintenance-only)

- **Tier=core, verdict=tangled:** `plugin` (the plugin manager itself),
  `federation` (federation primitive). Cannot be plugins-of-plugins.
- **Tier=core, verdict=clean:** `inbox`, `ls`, `peers`, `scope`, `trust`.
  Daily-driver primitives — keep close, low surface.
- **`init`**: even after extraction strategy lands, the first-run wizard
  must ship in the binary. Maintenance-only.

### Stub cleanup

- `hey-test` has no `plugin.json` and hasn't moved since 2026-04-13. Either
  promote to `test/` fixture or delete in a follow-up PR.

## Open questions for Phase 1

1. Bundle granularity: one community repo per plugin (matches `shellenv`,
   `rename`) or per workflow set (fleet/oracle/team)? Bundles ship faster;
   per-plugin gives finer profile control.
2. Profile names: confirm `minimal` / `dev` / `federation` / `full` /
   `legacy` from the #640 epic body, or open a new RFC.
3. `tmux` placement: today it's `extra` but every fleet plugin depends on
   it. May need a hidden "fleet runtime" tier that's auto-activated when
   any fleet plugin is selected.

## References

- #640 — lean-core epic (parent)
- #886 — this audit (Phase 0)
- #816, #848 — `shellenv` extraction (path A.2 reference)
- #859 — `rename` extraction (path A.3 reference)
- #827 — `src/cli/plugin-bootstrap.ts` (the loader these plugins target)
- #402 — plugins-standalone-load (prerequisite for Wave 3)
- #626 — SDK exports complete (prerequisite for Wave 3)
- #623 — marketplace RFC (downstream of profiles)
