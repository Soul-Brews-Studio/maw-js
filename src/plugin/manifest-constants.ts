/**
 * Plugin manifest — shared constants and regex patterns.
 */

/** Capability namespaces seeded in Phase A. Unknown namespaces emit a
 * validation warning (not a hard fail). New namespaces need an ADR.
 *
 * #874 — added `tmux` and `shell` after community plugins (bg, rename, park,
 * shellenv) declared them. `tmux` covers tmux-socket spawning via the SDK's
 * tmux/Tmux helpers (src/core/transport/tmux). `shell` covers shell-eval style
 * stdout writes for shell-environment plugins. Both are advisory in Phase A —
 * mirroring the rest of this list — and gate-able once the runtime grows real
 * capability enforcement (#487 follow-up). */
export const KNOWN_CAPABILITY_NAMESPACES = new Set([
  "net",    // network (fetch, sockets)
  "fs",     // filesystem
  "peer",   // federation peers (hey, send)
  "sdk",    // maw SDK calls (identity, federation, …)
  "proc",   // child processes
  "ffi",    // native FFI (bun:ffi)
  "tmux",   // tmux socket interaction (spawnSync("tmux", …) + SDK tmux helpers)
  "shell",  // shell-eval / stdout-writing plugins (shellenv-style)
]);

/**
 * Plugin membership tiers (#675 / #890). Same shape as KNOWN_CAPABILITY_NAMESPACES
 * — a single source of truth for the validator and the profile resolver. Tier is
 * an OPTIONAL field on plugin.json: missing → treated as "core" by the loader's
 * profile filter (Phase 2 of #640). The TypeBox schema in src/lib/schemas.ts
 * mirrors this list.
 *
 *   - core      essential primitives (scope, trust, inbox, ls, hey, help, …)
 *   - standard  daily drivers that aren't strictly required
 *   - extra     opt-in / experimental plugins
 *
 * See docs/lean-core/plugin-audit.md (#887) for the per-plugin classification.
 */
export const KNOWN_TIERS = ["core", "standard", "extra"] as const;
export type KnownTier = typeof KNOWN_TIERS[number];

/** Default tier when plugin.json omits the field. Used by the profile loader's
 *  tier filter so untiered plugins ride along with the most conservative
 *  profile (matches the audit doc — missing tier → assumed core / always-on). */
export const DEFAULT_TIER: KnownTier = "core";

export const NAME_RE = /^[a-z0-9-]+$/;

// Semver: N.N.N with optional pre-release (-alpha.1) and build metadata (+001)
export const SEMVER_CORE = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?/;
export const SEMVER_RE = new RegExp(`^${SEMVER_CORE.source}$`);

// Semver range: *, bare semver, or operator-prefixed semver (^, ~, >=, <=, >, <)
export const SEMVER_RANGE_RE = new RegExp(
  `^(\\^|~|>=?|<=?)?${SEMVER_CORE.source}$|^\\*$`,
);
