#!/usr/bin/env bun
// CalVer bump for maw-js
//
// Scheme: v{yy}.{m}.{d}[-(alpha|beta).{N}]
// Spec:   https://github.com/Soul-Brews-Studio/mawjs-oracle/blob/main/%CF%88/inbox/2026-04-18_proposal-calver-skills-cli.md
// Ported from: Soul-Brews-Studio/arra-oracle-skills-cli (PR #262)
// Umbrella: #526
// Option A (#766): monotonic running counter — N starts at 0 each day,
// counts up per release. Walk existing tags AND package.json (#784) for
// today's date and pick max+1.
// Beta channel (#754): parallel hourly channel, independent counter.
// No timestamp encoded in the alpha/beta number; pure ordering.
// Timezone comes from the shell — set TZ=Asia/Bangkok in CI if needed.
//
// Usage:
//   bun scripts/calver.ts                  → 26.4.18-alpha.{next-N}
//   bun scripts/calver.ts --beta           → 26.4.18-beta.{next-N}
//   bun scripts/calver.ts --stable         → 26.4.18
//   bun scripts/calver.ts --check          → dry-run (no writes)

import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type Channel = "alpha" | "beta";
type Args = { stable: boolean; channel?: Channel; check: boolean; now?: Date };

function parseArgs(argv: string[]): Args {
  const args: Args = { stable: false, channel: "alpha", check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stable") args.stable = true;
    else if (a === "--beta") args.channel = "beta";
    else if (a === "--check" || a === "--dry-run") args.check = true;
    else if (a === "--hour") {
      console.error("--hour deprecated as of #766; CalVer now uses tag-walk monotonic counter");
      process.exit(2);
    }
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      console.error(HELP);
      process.exit(2);
    }
  }
  if (args.stable && args.channel === "beta") {
    console.error("--stable and --beta are mutually exclusive");
    process.exit(2);
  }
  return args;
}

const HELP = `Usage: bun scripts/calver.ts [options]

Compute next CalVer version and bump package.json.

Scheme: v{yy}.{m}.{d}[-(alpha|beta).{N}] — N is a monotonic running counter
that starts at 0 each day and counts up per release (Option A from #766).
Alpha and beta are independent channels with their own counters (#754).

Options:
  --stable         Cut stable (no alpha/beta suffix)
  --beta           Cut beta instead of alpha (separate counter)
  --check          Dry-run: print target, don't modify files
  -h, --help       Show help

Examples:
  bun scripts/calver.ts                  next alpha → 26.4.18-alpha.{next-N}
  bun scripts/calver.ts --beta           next beta  → 26.4.18-beta.{next-N}
  bun scripts/calver.ts --stable         stable cut → 26.4.18
  bun scripts/calver.ts --check          print only, no write`;

export function dateBase(now: Date): string {
  const yy = now.getFullYear() % 100;
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${yy}.${m}.${d}`;
}

/**
 * Walk git tags matching `v{base}-{channel}.*` and return the max N found,
 * or -1 if no matching tags exist for this date+channel yet.
 *
 * Backwards-compatible alias `maxAlphaFromTags(base, tags)` defaults to alpha.
 */
export function maxNFromTags(base: string, channel: Channel, tags: string[]): number {
  const prefix = `v${base}-${channel}.`;
  let max = -1;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const rest = tag.slice(prefix.length);
    // Option A: pure integer N (no further dots). Reject e.g. "12.0".
    if (!/^\d+$/.test(rest)) continue;
    const n = parseInt(rest, 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/**
 * Back-compat alias: alpha-only tag walk.
 */
export function maxAlphaFromTags(base: string, tags: string[]): number {
  return maxNFromTags(base, "alpha", tags);
}

/**
 * #784: walk package.json.version as an additional source-of-truth for the
 * monotonic counter. Post-#767, alpha releases merge to the `alpha` branch,
 * but `calver-release.yml` only fires on push to `main` — so no git tags get
 * created for in-flight alphas. Without this, tag-walk returns -1 and we
 * regress to alpha.0 on every alpha-branch run.
 *
 * Parses `vYY.M.D-{channel}.{N}` (with or without leading "v") and returns N
 * only if base+channel match today's. Rejects non-integer suffixes and
 * empty/missing strings (returns -1).
 */
export function maxNFromPackageJson(
  base: string,
  channel: Channel,
  packageVersion: string,
): number {
  if (!packageVersion) return -1;
  // Accept either `vYY.M.D-channel.N` or `YY.M.D-channel.N`.
  const stripped = packageVersion.startsWith("v") ? packageVersion.slice(1) : packageVersion;
  const prefix = `${base}-${channel}.`;
  if (!stripped.startsWith(prefix)) return -1;
  const rest = stripped.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return -1;
  const n = parseInt(rest, 10);
  return Number.isInteger(n) ? n : -1;
}

async function listChannelTags(base: string, channel: Channel): Promise<string[]> {
  const res = await $`git tag --list ${`v${base}-${channel}.*`}`.nothrow().quiet();
  if (res.exitCode !== 0) return [];
  return res.stdout.toString().split("\n").map(s => s.trim()).filter(Boolean);
}

export function computeVersion(args: Args, tags: string[] = [], packageVersion: string = ""): string {
  const now = args.now ?? new Date();
  const base = dateBase(now);
  if (args.stable) return base;
  const channel = args.channel ?? "alpha";
  // Take max of (tag-walk N, package.json N) — see maxNFromPackageJson (#784).
  const tagMax = maxNFromTags(base, channel, tags);
  const pkgMax = maxNFromPackageJson(base, channel, packageVersion);
  const max = Math.max(tagMax, pkgMax);
  const next = max + 1; // -1 → 0 if none yet today
  return `${base}-${channel}.${next}`;
}

async function tagExists(version: string): Promise<boolean> {
  const res = await $`git rev-parse --verify --quiet ${`v${version}`}`.nothrow().quiet();
  return res.exitCode === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.now ?? new Date();
  const base = dateBase(now);

  // #784: read package.json once up front so its version participates in the
  // source-of-truth set for the monotonic counter (see computeVersion).
  const pkgPath = join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const channelForTags: Channel = args.channel ?? "alpha";
  const tags = args.stable ? [] : await listChannelTags(base, channelForTags);
  const version = computeVersion(args, tags, pkg.version ?? "");
  const channel = args.stable ? "stable" : channelForTags;

  console.log(`Target: v${version}  [${channel}]`);

  if (args.check) {
    console.log("(check mode — no changes written)");
    return;
  }

  if (await tagExists(version)) {
    // Should never happen for alpha (we picked max+1) but stable can collide.
    console.error(`\n❌ tag v${version} already exists`);
    if (args.stable) {
      console.error(`   → stable for today already cut; nothing to do`);
    } else {
      console.error(`   → race detected: another tag was created between scan and bump`);
    }
    process.exit(1);
  }

  const old = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✓ package.json: ${old} → ${version}`);

  console.log(`
Next:
  git add package.json && git commit -m "bump: v${version}" && git push origin main
  → calver-release.yml creates v${version} tag + GitHub release (+ builds dist/maw)
  → dist/maw attached to release`);
}

if (import.meta.main) main();
