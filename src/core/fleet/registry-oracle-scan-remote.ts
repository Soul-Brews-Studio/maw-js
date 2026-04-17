/**
 * registry-oracle-scan-remote — GitHub API oracle discovery.
 *
 * Uses the gh CLI (for auth + pagination) to list repos in target orgs,
 * filters to -oracle suffix, then spot-checks each for a ψ/ directory.
 *
 * The ψ/ check is parallelized in batches (alpha.73, 2026-04-16) — the
 * sequential `execSync gh api` per oracle × ~1.5s × 34 oracles dragged
 * laris-co scans to ~50s. Bun.spawn with batch concurrency drops it 3-5×.
 */

import { execSync, execFileSync } from "child_process";

// Org name allowlist — rejects shell metacharacters. Matches GitHub's
// org name rules (alphanumeric + dash, no consecutive dashes, not
// starting with a dash). Defense in depth — execFileSync below doesn't
// invoke a shell, but keeps config values honest.
const ORG_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
import { loadConfig } from "../../config";
import type { OracleEntry } from "./registry-oracle-types";
import { deriveName } from "./registry-oracle-scan-local";

// Concurrent ψ/ checks per batch. GitHub's authenticated rate limit is
// 5000/hr — we're nowhere near that. The cap is process overhead from
// spawning gh CLI; 8 keeps CPU + fd usage modest.
const PSI_CHECK_BATCH_SIZE = 8;

async function checkPsi(fullName: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["gh", "api", `/repos/${fullName}/contents/ψ`, "--silent"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  return code === 0;
}

export async function scanRemote(orgs?: string[], verbose = true): Promise<OracleEntry[]> {
  const config = loadConfig();
  const defaultOrgs = config.githubOrgs || ["Soul-Brews-Studio", "laris-co"];
  const targetOrgs = orgs || defaultOrgs;
  const now = new Date().toISOString();
  const entries: OracleEntry[] = [];
  const seen = new Set<string>();

  for (const org of targetOrgs) {
    const orgStart = Date.now();
    try {
      // Allowlist check — invalid org names skip with a clear error rather
      // than potentially leaking metacharacters into gh api calls (closes #473).
      if (!ORG_NAME_RE.test(org)) {
        console.error(`\x1b[31m✗\x1b[0m invalid org name "${org}" — skipping`);
        continue;
      }

      // Per-org progress — always shown so the user sees something during the
      // multi-second gh API call. Was behind `if (verbose)` until 2026-04-16
      // (silent dead air for 10-30s confused users — see gist 773655c4).
      process.stdout.write(`  \x1b[90m⏳ scanning ${org}...\x1b[0m`);

      // Use gh CLI for auth-handled pagination. execFileSync passes args
      // discretely (no shell) — shell metacharacters in org can't escape.
      const out = execFileSync(
        "gh",
        [
          "api",
          `/orgs/${org}/repos?per_page=100&type=all`,
          "--paginate",
          "--jq",
          '.[] | .full_name + " " + .name',
        ],
        { encoding: "utf-8", timeout: 30000 },
      );

      const repos = out.trim().split("\n").filter(Boolean);
      const oracleRepos = repos.filter(l => l.split(" ")[1]?.endsWith("-oracle"));
      const orgElapsed = ((Date.now() - orgStart) / 1000).toFixed(1);
      console.log(` \x1b[32m✓\x1b[0m ${repos.length} repos, ${oracleRepos.length} oracles (${orgElapsed}s)`);

      // Parallelize ψ/ checks in batches. Sequential = ~1.5s × N oracles.
      // Per-repo "checking..." preview was dropped (interleaving with parallel
      // writes is messy); user gets results streamed in batch-sized chunks
      // instead. The per-batch latency (~1.5-2s) is short enough that the
      // visual rhythm still feels active.
      for (let i = 0; i < oracleRepos.length; i += PSI_CHECK_BATCH_SIZE) {
        const batch = oracleRepos.slice(i, i + PSI_CHECK_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (line) => {
            const [fullName, repoName] = line.split(" ");
            if (!repoName) return null;
            if (seen.has(fullName)) return null;
            seen.add(fullName);
            const hasPsi = await checkPsi(fullName);
            return { fullName, repoName, hasPsi };
          }),
        );

        for (const r of results) {
          if (!r) continue;
          // Match original visual format: "  [grey]  <repoName>...[reset] [color]ψ/ or —[reset]"
          process.stdout.write(`  \x1b[90m  ${r.repoName}...\x1b[0m`);
          console.log(r.hasPsi ? " \x1b[32mψ/\x1b[0m" : " \x1b[90m—\x1b[0m");

          entries.push({
            org,
            repo: r.repoName,
            name: deriveName(r.repoName),
            local_path: "",
            has_psi: r.hasPsi,
            has_fleet_config: false,
            budded_from: null,
            budded_at: null,
            federation_node: null,
            detected_at: now,
          });
        }
      }
    } catch (err) {
      // Newline first so error doesn't concatenate with the "scanning..." line above
      console.log();
      console.warn(`  \x1b[33m⚠\x1b[0m [oracle-registry] ${org} failed: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
