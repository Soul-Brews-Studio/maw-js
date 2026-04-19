import { hostExec } from "../../../sdk";
import { existsSync } from "fs";

/**
 * Ask ghq where it parked a repo. Authoritative over `config.ghqRoot` —
 * which can drift (stale overrides, cross-host config sync). #630
 */
async function resolveGhqPath(slug: string): Promise<string | null> {
  try {
    const out = await hostExec(`ghq list --exact --full-path github.com/${slug}`);
    const first = out.split("\n").map(s => s.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Step 1: Ensure the oracle's GitHub repo exists and is cloned locally.
 * Idempotent — skips creation/clone if already present.
 *
 * Returns the ACTUAL clone path reported by ghq, not the predicted
 * `budRepoPath`. The two diverge when `config.ghqRoot` is stale or
 * overridden (#630) — ghq always honors its own `ghq root`, so trust it.
 */
export async function ensureBudRepo(
  budRepoSlug: string,
  budRepoPath: string,
  budRepoName: string,
  org: string,
): Promise<string> {
  if (existsSync(budRepoPath)) {
    console.log(`  \x1b[90m○\x1b[0m repo already exists: ${budRepoPath}`);
    return budRepoPath;
  }
  // Pre-check ghq in case the repo is already cloned but at a different path
  // than config.ghqRoot predicts — avoid re-creating on GitHub.
  const preExisting = await resolveGhqPath(budRepoSlug);
  if (preExisting) {
    console.log(`  \x1b[90m○\x1b[0m repo already cloned (via ghq): ${preExisting}`);
    return preExisting;
  }
  console.log(`  \x1b[36m⏳\x1b[0m creating repo: ${budRepoSlug}...`);
  try {
    // Pre-check: if repo already exists on GitHub, skip creation
    const viewCheck = await hostExec(`gh repo view ${budRepoSlug} --json name 2>/dev/null`).catch(() => "");
    if (viewCheck.includes(budRepoName)) {
      console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
    } else {
      await hostExec(`gh repo create ${budRepoSlug} --private --add-readme`);
      console.log(`  \x1b[32m✓\x1b[0m repo created on GitHub`);
    }
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
    } else if (e.message?.includes("403") || e.message?.includes("admin")) {
      throw new Error(
        `no permission to create repos in ${org} — ask an org admin to create ${budRepoSlug} first, then re-run maw bud`,
      );
    } else {
      throw e;
    }
  }
  await hostExec(`ghq get github.com/${budRepoSlug}`);
  // #630 — trust `ghq list`, not `config.ghqRoot`. The config value can be
  // stale or overridden (observed: ghqRoot="/tmp/nope" while real ghq root was
  // /home/neo/Code), which stranded the bud mid-scaffold. Resolve the real
  // landing path and use that for all downstream ψ/ + fleet + wake steps.
  const actualPath = await resolveGhqPath(budRepoSlug);
  if (!actualPath) {
    throw new Error(
      `ghq get succeeded but ghq list cannot find github.com/${budRepoSlug}.\n` +
      `  Check: ghq list | grep ${budRepoName}\n` +
      `  This indicates a broken ghq install or a reroute intercepting the URL.`,
    );
  }
  if (actualPath !== budRepoPath) {
    console.log(`  \x1b[33m⚠\x1b[0m config.ghqRoot predicted ${budRepoPath}`);
    console.log(`  \x1b[33m  but ghq parked the clone at ${actualPath}\x1b[0m`);
    console.log(`  \x1b[90m  using ghq's location — run 'maw init --force' to refresh config\x1b[0m`);
  }
  console.log(`  \x1b[32m✓\x1b[0m cloned via ghq → ${actualPath}`);
  return actualPath;
}
