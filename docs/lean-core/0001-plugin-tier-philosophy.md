# ADR 0001: Plugin Tier Philosophy

**Status**: Accepted (2026-04-29)
**Discussion**: [#640](https://github.com/Soul-Brews-Studio/maw-js/issues/640)
**Tracking**: [#893](https://github.com/Soul-Brews-Studio/maw-js/issues/893)
**Target**: v26.5.x alpha cycle (Phase 5 of #640 lean-core epic)
**Authors**: mawjs-oracle@white, mawjs-oracle@m5

## Context

`maw-js` ships 70 in-tree plugins (71 entries in `src/commands/plugins/`, one of which is the `hey-test` stub without a `plugin.json`). Every install pays for every plugin. This was tolerable when the tree held a dozen commands; at 70 it is no longer tolerable.

Three pressures forced the decision recorded here:

1. **Boot cost** — each plugin's `plugin.json` is parsed, capabilities inferred, manifest validated, and entry point resolved on every CLI invocation. The hot path's only tool against this is "load less."
2. **Testability** — `bun run test:all` walks the registry. Plugins that nobody uses still drag their fixtures, helpers, and integration paths into CI. The slowest tests today are not core paths; they are workflow-specific plugins that 90% of operators will never touch.
3. **Marketplace viability** — #623 opens the door to community plugins, and #816 / #848 / #859 already proved the extraction shape works (`shellenv`, `rename`). But "extract everything" is not a strategy. Without a tier policy we cannot tell extractors *which* plugins should leave the tree, and we cannot tell installers *which* plugins they actually need.

The Phase 0 audit (#886, doc landed in #887) classified every plugin into three buckets:

- **8 core** plugins — every install needs them (federation primitives, plugin manager itself, identity scope, trust, peers, inbox, ls).
- **13 standard** plugins — most installs benefit (doctor, health, wake, sleep, peek, view, send, send-enter, run).
- **49 extra** plugins — opt-in workflows (fleet/oracle/team/bud/UI/etc.).

Half of the tree is **clean-extract** today: 35 plugins depend only on the SDK + `plugin/types`. The other half (`tangled`) reaches into `core/fleet`, `core/matcher`, peer plugins, or shared helpers and requires SDK widening before it can leave.

A tier scheme alone is not enough. We also need a *loading policy* that honors tiers: a profile system that maps a name (`minimal`, `dev`, `federation`, `all`) to a plugin set, plus a hot-path filter that drops everything outside the active profile before the registry is exposed to the command surface. Phase 1 (#888 / #889) shipped the profile primitive; Phase 2 (#890 / #891) wired it into `discoverPackages()`. This ADR records the tier *philosophy* those phases assume — the rule that decides which plugins live where, who maintains them, and how the boundary moves over time.

## Decision

`maw-js` adopts a **three-tier plugin system** with **profile-driven loading**. Tier is a property of the plugin (declared in `plugin.json`); profile is a property of the install (selected by the operator). The two compose: profiles narrow the active plugin set; tier defaults make the narrowing predictable for legacy plugins that haven't been classified yet.

### Tier 1 — `core` (every install)

Plugins that the binary cannot meaningfully function without. Federation primitives, the plugin manager itself, the parser, the loader, config, the serve loop, identity (scope, trust), peer registry, inbox, ls.

Reference set as of this ADR (per #886):

> `cli`, `parse-args`, `loader`, `config`, `serve`, `info`, `scope`, `trust`, `inbox`, `peers`, `ls`, `federation`, `plugin`

(Some of these — `cli`, `parse-args`, `loader`, `config`, `serve`, `info` — live under `src/cli/` and `src/config/` rather than `src/commands/plugins/`. They are core *infrastructure* and out of audit scope, but the philosophy applies: they are the load-bearing primitives nothing else can exist without.)

Core plugins **stay in the binary forever**. They are not candidates for community extraction. They are the ABI surface that everything else depends on.

### Tier 2 — `standard` (most installs)

Plugins that are not strictly required but that almost every operator wants. The canonical send-loop (`send`, `send-enter`, `run`), lifecycle (`wake`, `sleep`), federation read (`peek`, `view`), health (`doctor`, `health`).

Standard plugins ship in the **default profile** (currently `all`, which preserves today's behavior — see migration note below). They can live in-tree or be bundled as `@maw/standard` once Phase 3 lands. Either way, the operator never has to opt in.

Standard is the **conservative tier**. When a plugin's tier is unclear, it goes to standard.

### Tier 3 — `extra` (opt-in)

Specialized workflows. Today this is 49 plugins covering fleet management (tmux, panes, tab, zoom, kill, restart, workon, split), oracle lineage (bud, oracle, soul-sync, done, reunion, archive, find), team/queue (team, pair, assign, cross-team-queue, take, talk-to, signals, consent, contacts, capture), and one-off tools (costs, ui, completions, demo, etc.).

Extra plugins are the **extraction target**. They eventually move to community repositories via the marketplace registry (#874, #623), the same shape `shellenv` (#816, #848) and `rename` (#859) already followed. Operators install them by name; the lean profile excludes them by default.

### Profile-driven loading

A **profile** is a named set of plugins. Profiles compose three signals:

1. **Explicit name list** — `plugins: ["wake", "sleep", "send"]` includes exactly those.
2. **Tier set** — `tiers: ["core", "standard"]` includes every plugin matching one of the listed tiers.
3. **Default tier mapping** — plugins missing a `tier` field are treated as `core` at the loader (the conservative read; see "Backwards compatibility" below).

The profile loader (`src/lib/profile-loader.ts`, #889) reads `<CONFIG_DIR>/profiles/<name>.json` and the active-profile pointer at `<CONFIG_DIR>/profile-active`. The plugin loader (`src/plugin/registry.ts`, #891) calls `resolveActiveProfileFilter()` once per process and drops every plugin outside the resolved set before the registry is exposed to dispatch.

The default profile is `"all"`. It has neither `plugins` nor `tiers` set, so the resolver returns `null` (passthrough) and every plugin loads. This keeps the Phase-2 default behavior identical to today; lean profiles are opt-in for the v26.5.x window.

### Backwards compatibility — defaults

Plugins shipped before this ADR have no `tier` field. The loader defaults them to `"core"` so a conservative tier filter (`profile.tiers === ["core"]`) does **not** silently exclude them. The pure resolver in `profile-loader.ts` keeps its Phase-1 contract (untiered = excluded from a tier-only profile); the default lives in the wiring layer where the audit's "missing → core" convention applies.

Plugin authors are expected to add `"tier": "core" | "standard" | "extra"` to `plugin.json` going forward. CONTRIBUTING.md documents the decision tree (this PR).

### Migration to community repos

Extra plugins eventually leave the tree. The order is set by the audit's verdict column (#887):

- **Wave 1** — clean extras (1–2 internal deps each): `artifact-manager`, `learn`, `on`, `project`, `triggers`, `incubate`, `session`, `about`, `avengers`, `broadcast`, `check`, `cleanup`, `completions`, `cross-team-queue`, `mega`, `pulse`, `stop`, `transport`, `pr`, `resume`, `reunion`, `demo`. Same shape as `shellenv` (#816, #848) and `rename` (#859). No SDK widening needed.
- **Wave 2** — clean standards bundled as `@maw/standard` once profile flag is stable.
- **Wave 3** — tangled extras, behind #626 (SDK exports complete) and #402 (plugins-standalone-load). Bundled by workflow: fleet, oracle/lineage, team/queue.
- **Wave 4** — never extracted: `plugin` (the manager itself), `federation`, `inbox`, `ls`, `peers`, `scope`, `trust`, `init`. Maintenance-only forever.

This ADR does not commit a date for any wave. It commits the *order* and the *shape*.

## Consequences

**Closes**:

- Tier ambiguity — every plugin now has one of three labels, declared at the manifest layer.
- Loading policy — profile + tier compose deterministically; the hot path knows what to skip.
- Extraction roadmap — `extra` is the queue, audit verdict is the priority.

**New requirements**:

- Plugin authors **must** declare `tier` in `plugin.json` for new plugins. Untiered plugins are accepted but treated as `core` by default — a conservative, backwards-compatible read.
- The profile loader (#889) is the single source of truth for "what is the active profile." All future tier-aware code reads `getActiveProfile()`.
- The plugin loader (#891) honors profile + tier filtering before dispatch sees the registry. New plugins do not need to know about profiles; the loader handles it.
- Extra plugins are eventually expected to move to community repositories via the registry (#874). Authors of new extra plugins should be prepared to maintain them out-of-tree.
- The default `"all"` profile preserves current behavior. Lean profiles (`minimal`, `dev`, `federation`) are operator opt-in.

**Doesn't close (deferred)**:

- Profile naming — confirmed names beyond `all` (`minimal`, `dev`, `federation`, `full`, `legacy`) are tracked in the audit's open questions.
- Per-plugin extraction PRs — each extra plugin's move to its own community repo is a separate PR; this ADR sets the philosophy, not the schedule.
- Bundle granularity — one repo per plugin vs. per workflow set is a Wave-3 decision, deferred until Phase 3 starts.
- `tmux` placement — today `extra` but every fleet plugin depends on it; may need a hidden "fleet runtime" tier auto-activated when any fleet plugin is selected (audit Q3).

**Migration window**:

- v26.5.x alpha cycle is the window for plugin authors to add `tier` fields and for operators to try lean profiles.
- No flag-gate; `tier` is additive and the default is "core" (safe). Lean profiles are opt-in via `maw profile use <name>`.
- v27.0.0 may tighten the default (`untiered` could become `extra` rather than `core`), but only after the in-tree extras have been audited and updated. That decision is out of scope for this ADR.

## References

- [#640](https://github.com/Soul-Brews-Studio/maw-js/issues/640) — lean-core epic (parent)
- [#886](https://github.com/Soul-Brews-Studio/maw-js/issues/886) / [#887](https://github.com/Soul-Brews-Studio/maw-js/pull/887) — Phase 0 plugin audit (8/13/49 split, clean/tangled verdicts)
- [#888](https://github.com/Soul-Brews-Studio/maw-js/issues/888) / [#889](https://github.com/Soul-Brews-Studio/maw-js/pull/889) — Phase 1 profile loader + `maw profile` CLI
- [#890](https://github.com/Soul-Brews-Studio/maw-js/issues/890) / [#891](https://github.com/Soul-Brews-Studio/maw-js/pull/891) — Phase 2 hot-path wiring (`discoverPackages` honors profile + tier)
- [#893](https://github.com/Soul-Brews-Studio/maw-js/issues/893) — Phase 5 (this ADR + CONTRIBUTING update)
- [#816](https://github.com/Soul-Brews-Studio/maw-js/pull/816) / [#848](https://github.com/Soul-Brews-Studio/maw-js/pull/848) — `shellenv` extracted to community repo (path A.2 reference)
- [#859](https://github.com/Soul-Brews-Studio/maw-js/pull/859) — `rename` extracted (path A.3 reference)
- [#874](https://github.com/Soul-Brews-Studio/maw-js/issues/874) — marketplace registry (downstream of profiles)
- [#623](https://github.com/Soul-Brews-Studio/maw-js/issues/623) — marketplace RFC
- [#626](https://github.com/Soul-Brews-Studio/maw-js/issues/626) — SDK exports complete (Wave 3 prerequisite)
- [#402](https://github.com/Soul-Brews-Studio/maw-js/issues/402) — plugins-standalone-load (Wave 3 prerequisite)
- `docs/lean-core/plugin-audit.md` — supporting data (per-plugin classification + verdicts)
- `src/lib/profile-loader.ts` — profile primitive (#889)
- `src/plugin/registry.ts` — hot-path filter (#891)
- `src/plugin/tier.ts` — `weightToTier` helper (used during the audit)
- `CONTRIBUTING.md` — adding-a-plugin decision tree (this PR)
