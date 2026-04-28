/**
 * Plugin registry — discover plugin packages and invoke them.
 *
 * Scans the canonical plugin install directory for packages with a plugin.json:
 *   ~/.maw/plugins/<name>/plugin.json
 *
 * Reuses wasm-bridge.ts infra (buildImportObject, preCacheBridge, readString, textEncoder).
 * Timeout: 5s hard limit matching command-registry.ts:193 pattern.
 *
 * ── Phase A gates (enforced at load time, not call-time) ────────────────────
 *  1. Semver gate — `manifest.sdk` must satisfy the runtime SDK version.
 *     Mismatch → plugin refused with an actionable error message.
 *  2. Artifact hash — if `manifest.artifact.sha256` is set on a real (non-symlink)
 *     install, the on-disk bundle's sha256 must match. Mismatch → refuse.
 *  3. Dev-mode (symlink) detection — if ~/.maw/plugins/<name>/ is a symlink,
 *     we treat it as a `linked (dev)` install and skip hash verification
 *     entirely. This replaces the rejected `sha256: "dev"` sentinel idea
 *     (sdk-consumer's cleaner label-only approach).
 *  4. Legacy manifests (no artifact field) still load — warn once, allow.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { loadManifestFromDir } from "./manifest";
import { loadConfig } from "../config";
import { verbose, info } from "../cli/verbosity";
import type { LoadedPlugin } from "./types";
import { satisfies, formatSdkMismatchError } from "./registry-semver";
import {
  runtimeSdkVersion,
  scanDirs,
  hashFile,
  isDevModeInstall,
  warnLegacyOnce,
} from "./registry-helpers";
import { resolveActiveProfileFilter, resetProfileFilterCache } from "../lib/profile-loader";

// Re-export everything that external callers import from this module
export { satisfies, formatSdkMismatchError } from "./registry-semver";
export {
  runtimeSdkVersion,
  hashFile,
  isDevModeInstall,
  __resetDiscoverStateForTests,
} from "./registry-helpers";
export { invokePlugin } from "./registry-invoke";

/**
 * In-process memoization of the discovery result. Populated lazily on the
 * first `discoverPackages()` call within a CLI invocation; reused by all
 * subsequent calls in the same process. Tests / install-flows that mutate
 * plugin state during a single invocation can clear it via
 * `resetDiscoverCache()`.
 *
 * Why: profiler agent (loop iter 9, 2026-04-16) measured ~50ms per call,
 * called 2× on the unknown-cmd path (cli.ts:66 → fuzzy → then again via
 * hooks-registry). Per-invocation cache kills the redundant rescan
 * without affecting fresh reads across different CLI invocations (each
 * bun invocation is a new process, cache starts empty).
 */
let _discoverCache: LoadedPlugin[] | null = null;

/** Clear the discovery cache. For install-flow + tests. Also flushes the
 *  profile-resolver cache so a re-scan picks up new plugins under the
 *  active profile filter (#890). */
export function resetDiscoverCache(): void {
  _discoverCache = null;
  resetProfileFilterCache();
}

/**
 * Scan the canonical plugin package directory and return valid packages.
 * Each subdirectory is checked for a plugin.json manifest. Plugins that
 * fail the Phase A gates (semver / hash) are refused with a loud message
 * and NOT returned — they do not enter the runtime command surface.
 *
 * Result is memoized within the current process. Call `resetDiscoverCache()`
 * after mutating plugin state (install, build) to force a fresh scan.
 */
export function discoverPackages(): LoadedPlugin[] {
  if (_discoverCache !== null) return _discoverCache;
  const plugins: LoadedPlugin[] = [];
  const disabled = loadConfig().disabledPlugins ?? [];
  const runtimeVer = runtimeSdkVersion();
  let legacyCount = 0;
  // #355 — aggregate mode counts for a single compact summary line instead
  // of 53 lines of per-plugin load noise. Skills-cli's test-agents run flagged
  // the per-plugin output as UX pollution. Verbose-by-default is still the
  // invariant (#343), but the right grain is SUMMARY, not per-entry.
  const modeCounts = { symlink: 0, artifact: 0, unbuilt: 0, legacy: 0 };

  for (const baseDir of scanDirs()) {
    if (!existsSync(baseDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgDir = join(baseDir, entry);
      let loaded: LoadedPlugin | null;
      try {
        loaded = loadManifestFromDir(pkgDir);
      } catch {
        // Invalid manifest — skip silently (noisy dirs in ~/.maw/plugins
        // that aren't plugins shouldn't spam users).
        continue;
      }
      if (!loaded) continue;

      const m = loaded.manifest;

      // Gate 1: SDK semver. Mismatch → refuse with actionable error.
      if (!satisfies(runtimeVer, m.sdk)) {
        console.warn(formatSdkMismatchError(m.name, m.sdk, runtimeVer));
        continue;
      }

      // Gate 2: artifact hash (real installs only — dev-mode skips).
      const devMode = isDevModeInstall(pkgDir);
      if (m.artifact && !devMode) {
        if (m.artifact.sha256 === null) {
          console.warn(
            `\x1b[33m⚠\x1b[0m plugin '${m.name}' is unbuilt — run \`maw plugin build\` in ${pkgDir}`,
          );
          continue;
        }
        // Resolve artifact path against the plugin dir.
        const artifactPath = join(pkgDir, m.artifact.path);
        if (!existsSync(artifactPath)) {
          console.warn(
            `\x1b[31m✗\x1b[0m plugin '${m.name}' artifact missing: ${m.artifact.path}`,
          );
          continue;
        }
        const observed = hashFile(artifactPath);
        if (observed !== m.artifact.sha256) {
          console.warn(
            `\x1b[31m✗\x1b[0m plugin '${m.name}' artifact hash mismatch — refusing to load.\n` +
            `  expected: ${m.artifact.sha256}\n` +
            `  actual:   ${observed}\n` +
            `  fix: re-install from a trusted source or re-run \`maw plugin build\``,
          );
          continue;
        }
      } else if (!m.artifact) {
        // Legacy plugin (no artifact field). Allow — but count for the one-shot
        // warning. #343b flips #341b: symlinks now count too. Dev-mode symlinks
        // are legitimately "legacy-shaped" at runtime; omitting them under-reported
        // the real legacy footprint on mixed dev machines. --quiet suppresses via
        // warn(); --verbose exposes the per-plugin mode line below.
        legacyCount++;
      }

      if (disabled.includes(m.name)) {
        loaded.disabled = true;
      }

      // Aggregate mode for post-loop summary (#355 — replace 53 per-plugin
      // lines with one compact summary). Per-plugin detail is still
      // retrievable via `maw plugin ls` when needed.
      if (devMode) modeCounts.symlink++;
      else if (m.artifact?.sha256) modeCounts.artifact++;
      else if (m.artifact) modeCounts.unbuilt++;
      else modeCounts.legacy++;

      plugins.push(loaded);
    }
  }

  // #355 — one-line summary instead of per-plugin spam. Still emits via
  // verbose() so --quiet suppresses it (verbose-by-default invariant from #343).
  verbose(() => {
    const parts: string[] = [];
    if (modeCounts.symlink) parts.push(`${modeCounts.symlink} symlink`);
    if (modeCounts.artifact) parts.push(`${modeCounts.artifact} artifact`);
    if (modeCounts.unbuilt) parts.push(`${modeCounts.unbuilt} unbuilt`);
    if (modeCounts.legacy) parts.push(`${modeCounts.legacy} legacy`);
    if (parts.length) info(`loaded ${plugins.length} plugins (${parts.join(", ")})`);
  });

  warnLegacyOnce(legacyCount);

  // #404 — apply weight overrides so category survives `install --link` replaces
  // where the new plugin.json omitted `weight`.
  const overridesPath = join(scanDirs()[0]!, ".overrides.json");
  try {
    const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, number>;
    for (const p of plugins) {
      const w = overrides[p.manifest.name];
      if (typeof w === "number") p.manifest.weight = w;
    }
  } catch { /* absent or unreadable */ }

  // Sort by weight (lower = first, default 50) — like Drupal module weight
  plugins.sort((a, b) => (a.manifest.weight ?? 50) - (b.manifest.weight ?? 50));

  // Phase 2 (#890) — apply active-profile filter. Resolution happens at most
  // once per process via the cache in profile-loader.ts. The "all" profile
  // (default for fresh installs) returns null = passthrough, so the hot path
  // pays only one stat() call. Non-"all" profiles narrow the registry to the
  // resolved name set; everything outside is dropped silently here so it
  // never reaches the command surface.
  //
  // Tier defaulting (#890 spec): plugins missing the `tier` field are
  // treated as "core" at the loader layer so untiered legacy plugins stay
  // visible under conservative tier filters (e.g. profile.tiers === ["core"]).
  // The pure resolver in profile-loader.ts keeps its Phase-1 contract
  // (untiered = excluded); the default lives here in the wiring layer where
  // the audit doc's "missing → core" convention applies.
  const filter = resolveActiveProfileFilter(
    plugins.map((p) => ({
      name: p.manifest.name,
      tier: p.manifest.tier ?? "core",
    })),
  );
  const filtered = filter === null
    ? plugins
    : plugins.filter((p) => filter.has(p.manifest.name));

  _discoverCache = filtered;
  return filtered;
}
