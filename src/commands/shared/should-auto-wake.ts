/**
 * should-auto-wake.ts — single source of truth for the "should we wake?" decision.
 *
 * Sub-issue 1 of #736 Phase 2 / #835.
 *
 * Replaces 7 independent decisions scattered across:
 *   - src/commands/plugins/view/impl.ts          (maw a / maw view)
 *   - src/commands/shared/comm-send.ts           (maw hey — local + cross-node)
 *   - src/api/sessions.ts (POST /api/send)       (implicit wake on send)
 *   - src/api/sessions.ts (POST /api/wake)       (always wakes)
 *   - src/commands/shared/comm-peek.ts           (maw peek — never auto-wakes)
 *   - src/commands/plugins/bud/bud-wake.ts       (maw bud — auto-wakes new bud)
 *   - src/commands/plugins/wake/index.ts → cmdWake (maw wake — wakes if missing)
 *
 * Pure function — no I/O, no module dependencies. The decision is fed by
 * site-collected facts (isFleetKnown, isLive, force, etc.). Wake call sites
 * remain unchanged: they still call cmdWake / curlFetch /api/wake. Only the
 * decision branch consults this helper now.
 *
 * Each return shape is `{ wake, reason }` so logging + tests can assert WHY
 * the decision was made, not just the bit.
 *
 * Sub-PR 4 of #841 — callers may now pass a `manifest` (OracleManifestEntry)
 * instead of pre-computing `isFleetKnown` / `isLive`. The helper derives both
 * from the entry. This keeps wake decisions and oracle facts collocated under
 * the unified manifest view (#838) and removes the small-but-real bug class
 * where one site computed "fleet-known" via wake-resolve while another used
 * config.agents.
 */

import type { OracleManifestEntry } from "../../lib/oracle-manifest";

export type AutoWakeSite =
  | "view"        // maw a / maw view — fleet-known silent wake, unknown prompts (#549)
  | "hey"         // maw hey local — auto-wakes fleet-known per #780
  | "api-send"    // POST /api/send — implicit wake on send (federation receive)
  | "api-wake"    // POST /api/wake — always wakes (explicit wake endpoint)
  | "peek"        // maw peek — NEVER auto-wakes by design (#736 inventory)
  | "bud"         // maw bud — always wakes the freshly-budded oracle
  | "wake-cmd";   // maw wake — wakes if missing (canonical wake)

export interface ShouldAutoWakeOpts {
  /** Which call site is asking. Discriminates the policy. */
  site: AutoWakeSite;

  /** True if oracle has a live tmux session (cmdWake's detectSession path). */
  isLive?: boolean;

  /** True if oracle appears in fleet config (`/tmp/maw-fleet/*.json`). */
  isFleetKnown?: boolean;

  /** Operator passed --wake explicitly (force opt-in). */
  force?: boolean;

  /** Operator passed --no-wake explicitly (back-compat for scripts). */
  noWake?: boolean;

  /**
   * Whether this decision is being made for a target whose canonical session
   * id is fully spelled (`<peer>:<session>:<window>`). Some sites skip wake
   * for the canonical 3-part form because waking on a session id can no-op
   * or misroute. Currently only `hey` consults this.
   */
  isCanonicalTarget?: boolean;

  /**
   * Optional unified manifest entry for the target oracle (Sub-PR 4 of #841).
   *
   * When provided, the helper derives:
   *   - `isFleetKnown` from `entry.sources.includes("fleet")`
   *   - `isLive`       from `entry.isLive`
   *
   * MANIFEST WINS: if the caller ALSO passes `isFleetKnown` / `isLive`
   * directly, the manifest values take precedence. The rationale is that
   * the manifest is the unified view (#838) — once a caller has gone to
   * the trouble of looking the oracle up via `findOracle()`, the manifest
   * answer is more reliable than ad-hoc booleans the call site might have
   * captured from a stale registry. Other flags (`force`, `noWake`,
   * `isCanonicalTarget`) are NOT derivable from the manifest and continue
   * to come from the call site.
   *
   * When absent, all existing callers continue to work unchanged.
   *
   * `undefined` entry — a synonym for "I tried `findOracle()` and the
   * oracle isn't in any registry" — is treated as `isFleetKnown=false`,
   * `isLive=false` (the natural unknown-target default).
   */
  manifest?: OracleManifestEntry;
}

export interface ShouldAutoWakeDecision {
  /** Final answer — should the caller invoke its wake path? */
  wake: boolean;

  /** Short human-readable explanation. Stable for testing and logs. */
  reason: string;
}

/**
 * Decide whether the given oracle should be auto-woken on this call site.
 *
 * Decision matrix (derived from #736 inventory + per-site review):
 *
 *   peek      → ALWAYS false (peek is read-only by design)
 *   api-wake  → ALWAYS true  (the endpoint's whole purpose IS to wake)
 *   bud       → ALWAYS true  (a fresh bud must be woken; --no-wake ignored)
 *   wake-cmd  → if !isLive   (canonical wake is idempotent: already-live ⇒ no-op)
 *   view      → --no-wake skip / --wake force / fleet-known silent /
 *                else "ask" (caller handles TTY prompt)
 *   hey       → --no-wake skip / --wake force / canonical-target skip /
 *                fleet-known + !isLive → wake / else skip
 *   api-send  → on missing local session: wake unconditionally (legacy
 *                receive-side behavior). Caller passes isLive=false to
 *                trigger; isLive=true skips. force / noWake honored.
 */
export function shouldAutoWake(
  oracle: string,
  opts: ShouldAutoWakeOpts,
): ShouldAutoWakeDecision {
  const { site } = opts;

  // 0. Manifest-derived facts (Sub-PR 4 of #841).
  //    When the caller hands us an OracleManifestEntry, treat it as the
  //    source of truth for `isFleetKnown` and `isLive`. This collapses two
  //    previously-divergent code paths (wake-resolve fleet probe vs. ad-hoc
  //    config.agents check) into a single read of the unified view.
  let isFleetKnown = opts.isFleetKnown;
  let isLive = opts.isLive;
  if (opts.manifest !== undefined) {
    isFleetKnown = opts.manifest.sources.includes("fleet");
    isLive = opts.manifest.isLive;
  }

  // 1. Hard rules — explicit operator flags win on sites that honor them.
  // peek/bud/api-wake intentionally ignore the flags: their semantics are
  // fixed and shouldn't be overridable from the same call site.
  const flagSites: AutoWakeSite[] = ["view", "hey", "api-send", "wake-cmd"];
  if (flagSites.includes(site)) {
    if (opts.noWake) return { wake: false, reason: "--no-wake explicit deny" };
    if (opts.force)  return { wake: true,  reason: "--wake explicit force" };
  }

  // 2. Per-site policy.
  switch (site) {
    case "peek":
      // #736 inventory: peek is read-only, NEVER triggers wake.
      return { wake: false, reason: "peek never auto-wakes" };

    case "api-wake":
      // The endpoint exists to wake — always honor.
      return { wake: true, reason: "api-wake endpoint always wakes" };

    case "bud":
      // A freshly-cloned bud has no session yet. bud-wake.ts:80 always wakes
      // it as the closing step of finalizeBud. No --no-wake escape.
      return { wake: true, reason: "bud always wakes new oracle" };

    case "wake-cmd":
      // Canonical wake is idempotent: `cmdWake` is happy to be called on a
      // live oracle (it'll select the existing window). The helper still
      // returns the truthful answer so callers can log/skip if they want.
      if (isLive) return { wake: false, reason: "wake-cmd: already live (noop)" };
      return { wake: true, reason: "wake-cmd: missing — wake" };

    case "view":
      // #549 + #780: fleet-known names skip the y/N prompt → silent auto-wake.
      // Caller handles the unknown-name TTY prompt itself (decideWakePrompt).
      // The helper signals "ask" by returning wake:false with the ask reason
      // — view callers branch on the reason string to drive prompt vs error.
      if (isLive) return { wake: false, reason: "view: target already running" };
      if (isFleetKnown) {
        return { wake: true, reason: "view: fleet-known and not running" };
      }
      return { wake: false, reason: "view: unknown — caller should ask" };

    case "hey":
      // #791: cross-node canonical (<peer>:<session>:<window>) skips wake
      // because the session id is explicit. Local short form (no node prefix
      // or matches own node) waking on fleet-known + !isLive is the parity
      // with view (#780).
      if (opts.isCanonicalTarget) {
        return { wake: false, reason: "hey: canonical target — skip wake" };
      }
      if (isLive) return { wake: false, reason: "hey: target already running" };
      if (isFleetKnown) {
        return { wake: true, reason: "hey: fleet-known and not running" };
      }
      return { wake: false, reason: "hey: unknown target — no auto-wake" };

    case "api-send":
      // /api/send is the federation receive side. Historically waking is
      // implicit (no session → caller failures cascade). The helper lets the
      // route opt in by passing isLive=false; if the session is already up,
      // we explicitly skip. Mirrors hey's local-scope policy on isFleetKnown.
      if (isLive) return { wake: false, reason: "api-send: target already running" };
      if (isFleetKnown) {
        return { wake: true, reason: "api-send: fleet-known and not running" };
      }
      return { wake: false, reason: "api-send: unknown target — no auto-wake" };
  }
}
