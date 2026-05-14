/**
 * maw plugin install --tier <core|standard|extra> [--from <owner/repo>] (#1338)
 *
 * Bulk-install every plugin at the requested tier from a maw-plugin-registry
 * repo. The tier filter is read from `registry.json:plugins[<name>].tier` at
 * the top of the mpr repo — that aggregate is generated from each plugin's
 * `registry.meta.json` and exposes the same field via a single fetch.
 *
 * Source-of-truth NOTE (filed as #1341 — out of scope for this PR):
 *   maw-js currently reads `tier` from each plugin's `plugin.json` (see
 *   src/plugin/registry.ts:217 — `p.manifest.tier ?? "core"`). mpr does NOT
 *   author tier in plugin.json — it lives in registry.meta.json + the
 *   aggregated registry.json. So `maw plugin ls` mislabels mpr plugins as
 *   tier:core when their meta says otherwise. This --tier reader uses the
 *   CORRECT source (registry.json) so we don't compound the mismatch.
 *
 * Why this lives next to install-all-impl.ts: identical shape — enumerate a
 * set of plugin names, dispatch the existing single-source install per name,
 * collect a summary at the end. The set source differs (lock vs tier filter)
 * but the loop / failure-isolation / summary semantics are the same.
 *
 * Enumeration (option A from #1338 task spec):
 *   GET https://raw.githubusercontent.com/<from>/main/registry.json
 *   filter entries where tier === requested
 *
 * Why not `gh api repos/<from>/contents/plugins` + per-plugin meta fetch?
 * That's N+1 round-trips and the aggregated registry.json carries the same
 * tier field. One fetch wins for both correctness (same source-of-truth
 * project-wide) and latency.
 *
 * Idempotency: skip if `~/.maw/plugins/<name>` already exists. Matches the
 * "fresh-install fleet-recovery" UX from the issue — re-running after a
 * partial install should be safe.
 *
 * Install dispatch: re-uses the Vercel-style github source (`<from>/<name>`)
 * so the existing install-handlers + lockfile + pin logic all kick in
 * automatically. No bespoke download path.
 */

import { existsSync } from "fs";
import { join } from "path";
import { installRoot } from "./install-source-detect";

export const VALID_TIERS = ["core", "standard", "extra"] as const;
export type Tier = (typeof VALID_TIERS)[number];

export const DEFAULT_FROM = "Soul-Brews-Studio/maw-plugin-registry";

export interface InstallTierOptions {
  tier: Tier;
  from?: string;
  force?: boolean;
}

export interface InstallTierResult {
  total: number;
  installed: number;
  skipped: number;
  failed: { name: string; reason: string }[];
}

interface MprRegistryEntry {
  version?: string;
  tier?: string;
}
interface MprRegistry {
  plugins?: Record<string, MprRegistryEntry>;
}

export function isValidTier(v: string): v is Tier {
  return (VALID_TIERS as readonly string[]).includes(v);
}

/**
 * Fetch the upstream mpr registry.json from GitHub raw. Exposed for tests
 * to stub via MAW_TIER_REGISTRY_URL.
 */
export async function fetchTierRegistry(from: string): Promise<MprRegistry> {
  const override = process.env.MAW_TIER_REGISTRY_URL;
  const url = override || `https://raw.githubusercontent.com/${from}/main/registry.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`registry fetch failed: HTTP ${res.status} ${res.statusText}\n  url: ${url}`);
  }
  const parsed = (await res.json()) as MprRegistry;
  if (!parsed || typeof parsed !== "object" || !parsed.plugins || typeof parsed.plugins !== "object") {
    throw new Error(`invalid registry shape (missing .plugins): ${url}`);
  }
  return parsed;
}

/**
 * Return all plugin names in the upstream registry at the requested tier,
 * sorted for stable output.
 */
export function filterByTier(reg: MprRegistry, tier: Tier): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(reg.plugins ?? {})) {
    if (entry?.tier === tier) out.push(name);
  }
  return out.sort();
}

/** Already-installed check: `~/.maw/plugins/<name>` exists (symlink or dir). */
function isInstalled(name: string): boolean {
  return existsSync(join(installRoot(), name));
}

export async function cmdPluginInstallTier(opts: InstallTierOptions): Promise<InstallTierResult> {
  const from = opts.from ?? DEFAULT_FROM;
  const force = !!opts.force;

  console.log(`install --tier ${opts.tier}: enumerating ${from}/registry.json…`);
  const reg = await fetchTierRegistry(from);
  const names = filterByTier(reg, opts.tier);

  if (names.length === 0) {
    console.log(`no plugins with tier='${opts.tier}' in ${from}`);
    return { total: 0, installed: 0, skipped: 0, failed: [] };
  }

  console.log(`install --tier ${opts.tier}: ${names.length} candidate(s) — ${names.join(", ")}`);

  const failed: { name: string; reason: string }[] = [];
  let installed = 0;
  let skipped = 0;

  const { cmdPluginInstall } = await import("./install-impl");

  for (const name of names) {
    if (!force && isInstalled(name)) {
      console.log(`  - ${name}: already installed — skipping`);
      skipped++;
      continue;
    }
    // Vercel-style source: <owner>/<repo>/<name>. installFromGithub auto-
    // prefixes plugins/ when needed and picks the latest release ref.
    const source = `${from}/${name}`;
    console.log(`  → ${name} ← ${source}`);
    try {
      const args: string[] = [source];
      if (force) args.push("--force");
      // Propagate tier as the install --category so `maw plugin ls` groups
      // it visually under the same bucket the bulk install came from.
      args.push("--category", opts.tier);
      await cmdPluginInstall(args);
      installed++;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${name}: ${reason.split("\n")[0]}`);
      failed.push({ name, reason });
    }
  }

  console.log(
    `install --tier ${opts.tier}: ${installed}/${names.length} installed` +
      (skipped ? `, ${skipped} skipped` : "") +
      (failed.length ? `, ${failed.length} failed` : ""),
  );

  if (failed.length > 0) {
    throw new Error(`install --tier ${opts.tier}: ${failed.length} of ${names.length} failed`);
  }

  return { total: names.length, installed, skipped, failed };
}
