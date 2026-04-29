# ADR-0002: Top-level verb aliases supersede ADR-0001's "never extracted" promise

**Status**: Accepted
**Date**: 2026-04-30
**Supersedes (in part)**: [ADR-0001 §Wave 4 (line 84)](./0001-plugin-tier-philosophy.md)
**Tracking**: RFC #954

## Context

ADR-0001 made two claims that post-#946 reality has invalidated:

1. **Line 84 ("Wave 4")** listed `plugin`, `federation`, `inbox`, `ls`, `peers`, `scope`, `trust`, `init` as **"never extracted, maintenance-only forever"**.
2. **Line 22** placed `wake` in the **standard** tier, even though `wake/plugin.json` carried `weight: 0` (= core under `weightToTier`). The two signals disagreed; the ADR did not reconcile them.

What actually happened:

- **PR #918** (commit `b5aaf040`) silently extracted `ls` and `wake` along with the rest of the bulk-extract batch. No commit message, PR body, or vault file referenced ADR-0001 when explaining the deviation from the Wave-4 promise.
- By **PR #946** the in-tree surface had collapsed to **7 INFRA plugins**: `federation`, `fleet`, `oracle`, `plugin`, `session`, `tmux`, `transport`. Everything else — including four of the eight Wave-4 names — now lives in `Soul-Brews-Studio/maw-plugin-registry`.
- **PRs #948 and #952** further consolidated the post-extraction surface without revisiting the ADR.

The bulk-extract decision was pragmatic and the right call for the lean-core epic. The cost was an undocumented gap between ADR-0001's stated philosophy and the shipped tree. RFC #954 surfaced the gap while addressing a separate axis (verb prominence) and recommended this ADR to close the loop.

## Decision

1. **Retract** the "never extracted, maintenance-only forever" claim from ADR-0001 §Wave 4. It does not describe the post-#946 tree and has not since #918.
2. **Codify** the post-#946 reality: only **INFRA plugins** (`federation`, `fleet`, `oracle`, `plugin`, `session`, `tmux`, `transport`) are guaranteed to ship in `maw-js` core. Every other plugin is extractable and may live in the marketplace registry.
3. **Decouple** verb-level access from bundling. Non-INFRA commands that warrant top-level prominence (`maw ls`, `maw a`, `maw wake`) are surfaced via the **top-level alias table** specified in RFC #954, **not** by re-bundling the underlying plugin into core.

## Consequences

- **ADR-0001 §Wave 4 (line 84) is superseded by this ADR.** The tier-vs-extraction matrix in ADR-0001 should be read as historical context for the lean-core epic, not as a forward-looking guarantee.
- **Two axes are now explicit** (ADR-0001 conflated them):
  - *Axis 1 — plugin tier.* Controls **loading** under a profile. Driven by the `tier` field in `plugin.json` and the profile loader (`src/lib/profile-loader.ts`).
  - *Axis 2 — verb prominence.* Controls **top-level routing** and `maw --help` visibility. Driven by the `TOP_ALIASES` table introduced in RFC #954 (`src/cli/top-aliases.ts`).
  Aliases bypass profile filtering by design: alias = always available; registry plugin = optional re-tier.
- **"Promote to core" requests resolve via the alias map by default.** Re-bundling a plugin into the core tree now requires a fresh ADR with explicit justification — pragmatic deviations from this rule must reference the ADR they amend.
- **User-facing impact is minimal.** Operators who relied on `maw ls` and `maw wake` as in-tree commands continue to get them as top-level verbs. The handlers move (alias to `fleet ls` or in-tree `wake-cmd.ts`; registry plugin for original `ls/` semantics), but the entry point is preserved. Functionally equivalent, architecturally distinct.
- **The Wave-4 list is no longer authoritative.** Of the eight names, only `plugin` and `federation` remain in core; `inbox`, `ls`, `peers`, `scope`, `trust`, and `init` have either extracted or are eligible for extraction under the post-#946 policy.

## References

- [ADR-0001 — Plugin Tier Philosophy](./0001-plugin-tier-philosophy.md) (the document this ADR amends)
- PR #918 — bulk extraction (commit `b5aaf040`); first deviation from Wave 4
- PR #946 — INFRA-7 boundary established
- PR #948 — post-extraction consolidation
- PR #952 — post-extraction consolidation
- RFC #954 — top-level verb aliases (Axis 2 formalization)
