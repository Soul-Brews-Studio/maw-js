import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { FLEET_DIR } from "../../../core/paths";
import { loadFleetEntries } from "../../shared/fleet-load";

export function extractOracleStem(claudeMdPath: string): string | null {
  const line1 = readFileSync(claudeMdPath, "utf8")
    .split("\n")[0]
    .replace(/^#\s*/, "");
  if (!line1 || /project instructions|generic ai|quick reference/i.test(line1)) return null;
  return line1
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s*[Oo]racle\s*$/i, "")
    .replace(/\s*—.*$/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "") || null;
}

interface Orphan {
  repo: string;
  org: string;
  stem: string;
  path: string;
  identity: string;
}

function scanOrphans(): Orphan[] {
  let ghqRoot: string;
  try {
    ghqRoot = execSync("ghq root", { encoding: "utf8" }).trim();
  } catch { return []; }
  const repos = execSync("ghq list", { encoding: "utf8" }).trim().split("\n");
  const entries = loadFleetEntries();
  const registered = new Set(
    entries.flatMap(e => e.session.windows?.map(w => w.repo) ?? []),
  );

  const orphans: Orphan[] = [];
  for (const rel of repos) {
    if (rel.includes(".wt-")) continue;
    const full = join(ghqRoot, rel);
    const claudeMd = join(full, "CLAUDE.md");
    const psi = join(full, "ψ");
    if (!existsSync(claudeMd) || (!existsSync(psi) && !existsSync(join(full, "ψ")))) continue;

    const parts = rel.split("/");
    const org = parts[1] || "";
    const repo = parts[2] || basename(full);
    if (registered.has(`${org}/${repo}`)) continue;

    const identity = readFileSync(claudeMd, "utf8").split("\n")[0].replace(/^#\s*/, "");
    const stem = extractOracleStem(claudeMd);
    if (!stem) continue;

    orphans.push({ repo, org, stem, path: full, identity });
  }
  return orphans;
}

/**
 * Derive `{ org, repo }` from a local repo path.
 *
 * Tries ghq layout first (path inside `ghq root` → host/org/repo), then falls
 * back to `git remote get-url origin`. The bud lifecycle (#1147) creates repos
 * via `gh repo create` + `ghq get`, so both paths are reliable in practice.
 */
function deriveOrgRepo(repoPath: string): { org: string; repo: string } {
  // 1. ghq layout: <root>/<host>/<org>/<repo>
  try {
    const ghqRoot = execSync("ghq root", { encoding: "utf8" }).trim();
    const normalized = repoPath.replace(/\/+$/, "");
    if (ghqRoot && normalized.startsWith(ghqRoot + "/")) {
      const rel = normalized.slice(ghqRoot.length + 1);
      const parts = rel.split("/");
      if (parts.length >= 3 && parts[1] && parts[2]) {
        return { org: parts[1], repo: parts[2] };
      }
    }
  } catch { /* fall through */ }

  // 2. Fallback: git remote get-url origin
  try {
    const remote = execSync(
      `git -C ${JSON.stringify(repoPath)} remote get-url origin`,
      { encoding: "utf8" },
    ).trim();
    const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { org: m[1], repo: m[2] };
  } catch { /* fall through */ }

  throw new Error(`adoptByPath: cannot derive org/repo for ${repoPath} (not under ghq root, no origin remote)`);
}

export interface AdoptByPathOpts {
  /** Don't write the fleet config file; still compute and return what would be written. */
  dryRun?: boolean;
  /** Override the stem (defaults to the one extracted from CLAUDE.md line 1). */
  as?: string;
}

export interface AdoptByPathResult {
  /** Numeric slot (e.g. 27 → `27-foo.json`). */
  slot: number;
  /** Absolute path of the fleet config file (written, or would-be written when dry-run). */
  configPath: string;
  /** The fleet stem (after override, lowercased, slug-form). */
  groupName: string;
  /** The full session config that was (or would be) written. */
  config: {
    name: string;
    windows: Array<{ name: string; repo: string }>;
    adopted_at: string;
    adopted_from: string;
  };
  /** True iff the file was actually written (false in dry-run). */
  written: boolean;
}

/**
 * Adopt a local oracle repo into the fleet — register a `<NN>-<stem>.json`
 * config under `FLEET_DIR` so `maw wake <stem>` can resolve it deterministically.
 *
 * Importable helper for the maw-js side of #1147 (bud lifecycle completion).
 * The CLI (`maw fleet adopt <name>`) calls this internally.
 *
 * Throws if:
 * - `repoPath/CLAUDE.md` is missing or its first line yields no stem
 * - the stem already exists in the fleet (pass `opts.as` to override)
 * - the org/repo can't be derived (not under ghq root, no `origin` remote)
 */
export async function adoptByPath(
  repoPath: string,
  opts: AdoptByPathOpts = {},
): Promise<AdoptByPathResult> {
  const { dryRun = false, as: nameOverride } = opts;

  const claudeMd = join(repoPath, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    throw new Error(`adoptByPath: CLAUDE.md not found at ${repoPath}`);
  }

  const stem = nameOverride ?? extractOracleStem(claudeMd);
  if (!stem) {
    throw new Error(`adoptByPath: could not extract oracle stem from ${claudeMd}`);
  }

  const { org, repo } = deriveOrgRepo(repoPath);

  const entries = loadFleetEntries();
  if (entries.some(e => e.groupName === stem)) {
    throw new Error(`adoptByPath: stem '${stem}' already exists in fleet — pass opts.as to override`);
  }
  if (entries.some(e => e.session.windows?.some(w => w.repo === `${org}/${repo}`))) {
    throw new Error(`adoptByPath: ${org}/${repo} is already registered in fleet`);
  }

  const slot = entries.reduce((max, e) => Math.max(max, e.num), 0) + 1;
  const fileName = `${String(slot).padStart(2, "0")}-${stem}.json`;
  const configPath = join(FLEET_DIR, fileName);
  const config = {
    name: `${String(slot).padStart(2, "0")}-${stem}`,
    windows: [{ name: `${stem}-oracle`, repo: `${org}/${repo}` }],
    adopted_at: new Date().toISOString(),
    adopted_from: `ghq:${org}/${repo}`,
  };

  if (!dryRun) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  return { slot, configPath, groupName: stem, config, written: !dryRun };
}

export async function cmdFleetAdopt(args: string[]) {
  const isScan = args.includes("--scan");
  const isDryRun = args.includes("--dry-run");
  const asIdx = args.indexOf("--as");
  const nameOverride = asIdx !== -1 ? args[asIdx + 1] : undefined;
  const targets = args.filter(a => !a.startsWith("--") && a !== nameOverride);

  if (isScan) {
    const orphans = scanOrphans();
    if (orphans.length === 0) {
      console.log("  \x1b[32m✓\x1b[0m No orphan oracles — fleet is complete.");
      return;
    }
    console.log(`  Orphan oracles (\x1b[33m${orphans.length}\x1b[0m not in fleet):\n`);
    for (let i = 0; i < orphans.length; i++) {
      const o = orphans[i];
      console.log(`  ${String(i + 1).padStart(3)}  ${o.repo.padEnd(35)} → ${o.identity.substring(0, 30).padEnd(30)} (${o.org})`);
    }
    console.log(`\n  Adopt: \x1b[36mmaw fleet adopt <repo-name>\x1b[0m`);
    return;
  }

  if (targets.length === 0) {
    console.log("  usage: maw fleet adopt <repo-name> [--as <stem>] [--dry-run]");
    console.log("         maw fleet adopt --scan");
    return;
  }

  const orphans = scanOrphans();

  for (const target of targets) {
    const match = orphans.find(o => o.repo === target || o.stem === target || o.repo.includes(target));
    if (!match) {
      console.log(`  \x1b[31m✗\x1b[0m '${target}' not found or already in fleet`);
      continue;
    }

    try {
      const result = await adoptByPath(match.path, {
        dryRun: isDryRun,
        as: nameOverride ?? match.stem,
      });

      if (!result.written) {
        console.log(`  \x1b[90m[dry-run]\x1b[0m would create: ${basename(result.configPath)}`);
        console.log(JSON.stringify(result.config, null, 2));
        continue;
      }

      console.log(`  \x1b[32m✅\x1b[0m adopted: ${match.repo} → ${result.groupName} (${basename(result.configPath)})`);
      console.log(`     repo: ${match.org}/${match.repo}`);
      console.log(`     fleet: ~/.config/maw/fleet/${basename(result.configPath)}`);
      console.log(`     next: \x1b[36mmaw wake ${result.groupName}\x1b[0m`);
    } catch (e) {
      console.log(`  \x1b[31m✗\x1b[0m ${(e as Error).message}`);
    }
  }
}
