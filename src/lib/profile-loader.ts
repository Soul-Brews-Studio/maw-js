/**
 * profile-loader.ts — read/write profile JSON files + active-profile pointer.
 *
 * Phase 1 of #640 (lean-core epic) / closes #888.
 *
 * Background
 * ──────────
 * The lean-core epic wants operators to install a slim binary by default and
 * opt INTO heavier plugin sets via named profiles. Phase 0 (#886) classified
 * every plugin into core/standard/extra tiers. This module is Phase 1: the
 * read/write primitive plus a CLI plugin (`maw profile`) that lets operators
 * see what's available and pick one.
 *
 * **ADDITIVE ONLY.** This module does NOT touch the existing plugin loader.
 * Phase 2 (a separate sub-issue of #640) wires `getActiveProfile()` into
 * `discoverPackages()` so the lean profile actually narrows the registry. Until
 * then, all plugins continue to load as today — this layer just writes JSON.
 *
 * Storage layout
 * ──────────────
 *   <CONFIG_DIR>/profiles/<name>.json     # one file per profile
 *   <CONFIG_DIR>/profile-active           # single-line text file (just the name)
 *
 * Default profile
 * ───────────────
 * `getActiveProfile()` returns `"all"` when no pointer file exists. The "all"
 * profile is special: it has neither `plugins` nor `tiers` set, so
 * `resolveProfilePlugins()` returns the FULL plugin list. This keeps the
 * Phase 1 default behavior identical to today (no plugins filtered).
 *
 * On first use the loader auto-writes `~/.config/maw/profiles/all.json` if it
 * doesn't exist. This is a convenience — operators can immediately
 * `maw profile show all` without digging up sample JSON.
 *
 * Atomic writes
 * ─────────────
 * All writes go through `tmp + rename` to avoid partial files on crash. Same
 * pattern as `src/commands/plugins/peers/store.ts` and the scope plugin's
 * write path (#642 Phase 1).
 *
 * Path resolution
 * ───────────────
 * Like the scope primitive, paths are resolved at call-time (not import-time)
 * so tests can mutate `MAW_CONFIG_DIR` per-test. Mirrors the resolver in
 * src/commands/plugins/scope/impl.ts.
 *
 * See also:
 *   - docs/lean-core/plugin-audit.md (#887) — tier reference for untiered plugins
 *   - src/lib/schemas.ts — `Profile` TypeBox schema
 *   - src/commands/plugins/profile/ — CLI plugin (`maw profile`)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TProfile } from "./schemas";

// ─── Validation ──────────────────────────────────────────────────────────────

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateProfileName(name: string): string | null {
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) {
    return `invalid profile name "${name}" (must match ^[a-z0-9][a-z0-9_-]{0,63}$)`;
  }
  return null;
}

// ─── Paths (live-resolved, like the scope primitive) ─────────────────────────

function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function profilesDir(): string {
  return join(activeConfigDir(), "profiles");
}

export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}

export function activeProfilePath(): string {
  return join(activeConfigDir(), "profile-active");
}

function ensureProfilesDir(): void {
  mkdirSync(profilesDir(), { recursive: true });
}

// ─── Default "all" profile (auto-seeded on first read) ───────────────────────

/**
 * The "all" profile is the Phase-1 default. It deliberately has neither
 * `plugins` nor `tiers` set, so `resolveProfilePlugins` returns the FULL
 * plugin list — i.e. behavior identical to today.
 */
const DEFAULT_ALL_PROFILE: TProfile = {
  name: "all",
  description: "All plugins (Phase 1 default — equivalent to no profile filter).",
};

/**
 * Embedded fallback for the "minimal" profile referenced in the Phase 1 spec.
 * NOT auto-written to disk; operators opt-in by `maw profile use minimal` (which
 * fails fast if the file isn't there yet) or by writing the JSON themselves.
 *
 * Keeping this constant in source means the schema example in the issue body
 * stays grep-able after extraction. If/when a follow-up wires up a profile
 * `init` verb that scaffolds known profiles, this is the seed it uses.
 */
export const KNOWN_PROFILE_SEEDS: ReadonlyArray<TProfile> = [
  DEFAULT_ALL_PROFILE,
  {
    name: "minimal",
    plugins: ["scope", "trust", "inbox", "ls", "hey", "help"],
    tiers: ["core"],
    description: "Lean-core minimal profile — daily-driver primitives only.",
  },
];

/**
 * Ensure the default `all.json` profile exists on disk. Called lazily by
 * `loadProfile("all")` and `loadAllProfiles()`. Idempotent: if the file
 * exists, leaves it alone (operators may have edited it).
 */
function ensureDefaultProfile(): void {
  ensureProfilesDir();
  const path = profilePath("all");
  if (!existsSync(path)) {
    atomicWriteJSON(path, DEFAULT_ALL_PROFILE);
  }
}

// ─── Atomic write helper ─────────────────────────────────────────────────────

function atomicWriteJSON(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Load a profile by name. Returns `null` when the file doesn't exist or fails
 * to parse — callers translate null into a CLI-level "profile not found".
 *
 * Side effect: when called with "all" and the default file is missing, this
 * auto-writes `<CONFIG_DIR>/profiles/all.json` with the embedded default. Any
 * other name is read-only.
 */
export function loadProfile(name: string): TProfile | null {
  const nameErr = validateProfileName(name);
  if (nameErr) return null;
  if (name === "all") ensureDefaultProfile();

  const path = profilePath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TProfile;
    // Defensive normalization — operator hand-edits may drop the name field.
    if (typeof parsed.name !== "string") parsed.name = name;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load every profile under `<CONFIG_DIR>/profiles/`. Returns sorted by name.
 *
 * Same failure isolation as `loadManifest()` (#838): a single corrupt JSON file
 * is silently skipped — must NOT brick `maw profile list`.
 */
export function loadAllProfiles(): TProfile[] {
  ensureDefaultProfile();
  const dir = profilesDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TProfile[] = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const p = loadProfile(name);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

/**
 * Lite shape of a plugin entry — just enough for tier resolution. We accept
 * `unknown`-shaped plugin records so this module doesn't drag in the heavy
 * `LoadedPlugin` type from `src/plugin/types`. Callers (Phase 2) will pass the
 * already-discovered plugins.
 */
export interface PluginNameAndTier {
  name: string;
  tier?: "core" | "standard" | "extra";
}

/**
 * Resolve a profile to the concrete list of plugin names that should activate.
 *
 * Rules (additive — both fields contribute, no shadowing):
 *   - Profile has `plugins` only → return that list (filtered to known names).
 *   - Profile has `tiers` only   → return all plugins whose tier is in the
 *                                  filter. Plugins WITHOUT a tier field are
 *                                  not implicitly included (they fall through
 *                                  to the audit doc's classification at the
 *                                  caller layer).
 *   - Profile has BOTH           → UNION of the two sets, deduplicated.
 *   - Profile has NEITHER        → return all plugin names (the "all" case).
 *
 * Returns plugin names in the same order they appear in `allPlugins`, with
 * duplicates removed. Unknown names from `profile.plugins` are silently
 * dropped — Phase 1 prefers a permissive resolver so a missing plugin doesn't
 * block the whole CLI.
 */
export function resolveProfilePlugins(
  profile: TProfile,
  allPlugins: PluginNameAndTier[],
): string[] {
  const knownNames = new Set(allPlugins.map((p) => p.name));
  const tierMap = new Map(allPlugins.map((p) => [p.name, p.tier]));

  const hasPlugins = Array.isArray(profile.plugins) && profile.plugins.length > 0;
  const hasTiers = Array.isArray(profile.tiers) && profile.tiers.length > 0;

  // Empty profile → "all" semantics.
  if (!hasPlugins && !hasTiers) {
    return allPlugins.map((p) => p.name);
  }

  const accept = new Set<string>();

  if (hasPlugins) {
    for (const n of profile.plugins!) {
      if (knownNames.has(n)) accept.add(n);
    }
  }

  if (hasTiers) {
    const tierFilter = new Set(profile.tiers!);
    for (const p of allPlugins) {
      if (p.tier && tierFilter.has(p.tier)) accept.add(p.name);
    }
  }

  // Preserve input order so caller-side weight ordering survives.
  return allPlugins.map((p) => p.name).filter((n) => accept.has(n));
}

// ─── Per-process profile resolution cache (Phase 2 / #890) ──────────────────

/**
 * In-process cache of the active profile's resolved plugin set. The plugin
 * registry calls `resolveActiveProfileFilter()` once on first
 * `discoverPackages()`; subsequent calls in the same `maw` invocation reuse
 * the result. Mirrors `_discoverCache` in src/plugin/registry.ts.
 *
 * The cache key is the (active profile name + plugin-name fingerprint) so
 * adding/removing plugins between calls in the same process forces a refresh
 * (rare path — install flows already call resetDiscoverCache()).
 */
let _filterCache: { key: string; allowed: Set<string> | null } | null = null;

/** Reset the profile-resolution cache. Use after `setActiveProfile()` and
 *  in tests that mutate MAW_CONFIG_DIR mid-process. */
export function resetProfileFilterCache(): void {
  _filterCache = null;
}

/**
 * Resolve the active profile to a plugin-name allowlist, or `null` when the
 * profile is "all" / empty (== load everything, identical to pre-Phase-2
 * behavior).
 *
 * Hot path — every `maw` invocation hits this exactly once. Designed to be
 * cheap on the "all" branch (single file stat, no JSON parse).
 *
 * @returns `null` to mean "no filter, load all plugins". A `Set<string>` of
 *          allowed plugin names otherwise. Callers MUST treat `null` as the
 *          identity filter, not as "load nothing".
 */
export function resolveActiveProfileFilter(
  allPlugins: PluginNameAndTier[],
): Set<string> | null {
  const activeName = getActiveProfile();
  // "all" is the documented passthrough — short-circuit before any disk read
  // so the default install pays nothing for Phase 2.
  if (activeName === "all") return null;

  // Cache key folds in the plugin-name set so adding a plugin between two
  // calls in the same process still produces the right answer.
  const fingerprint = allPlugins
    .map((p) => `${p.name}:${p.tier ?? "core"}`)
    .sort()
    .join("|");
  const key = `${activeName}::${fingerprint}`;
  if (_filterCache && _filterCache.key === key) return _filterCache.allowed;

  const profile = loadProfile(activeName);
  if (!profile) {
    // Active profile points at a missing/corrupt file — fail open (load all)
    // and let `maw profile` surface the error. Bricking the CLI on a stray
    // active-profile pointer would be far worse than a permissive fallback.
    _filterCache = { key, allowed: null };
    return null;
  }

  const hasPlugins = Array.isArray(profile.plugins) && profile.plugins.length > 0;
  const hasTiers = Array.isArray(profile.tiers) && profile.tiers.length > 0;
  if (!hasPlugins && !hasTiers) {
    // Empty profile → "all" semantics, same as the "all" pointer above.
    _filterCache = { key, allowed: null };
    return null;
  }

  const allowed = new Set(resolveProfilePlugins(profile, allPlugins));
  _filterCache = { key, allowed };
  return allowed;
}

// ─── Active profile pointer ──────────────────────────────────────────────────

/**
 * Read the active profile name from `<CONFIG_DIR>/profile-active`.
 * Returns `"all"` when the file is missing, empty, or unreadable.
 */
export function getActiveProfile(): string {
  const path = activeProfilePath();
  if (!existsSync(path)) return "all";
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return "all";
    const err = validateProfileName(raw);
    if (err) return "all";
    return raw;
  } catch {
    return "all";
  }
}

/**
 * Write the active profile name. Validates the name before touching disk;
 * callers receive a thrown error on bad input. The pointer file is a
 * single-line text file (no JSON) so operators can `cat` or hand-edit it.
 */
export function setActiveProfile(name: string): void {
  const nameErr = validateProfileName(name);
  if (nameErr) throw new Error(nameErr);
  mkdirSync(activeConfigDir(), { recursive: true });
  const path = activeProfilePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, name + "\n", "utf-8");
  renameSync(tmp, path);
  // Phase 2 (#890): pointer change must invalidate the resolved-filter cache
  // so the next discoverPackages() call re-reads. Same pattern as
  // resetDiscoverCache() in src/plugin/registry.ts.
  resetProfileFilterCache();
}
