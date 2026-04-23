import { join } from "path";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { hostExec } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import { FLEET_DIR } from "../../../sdk";

/**
 * maw fleet consolidate [--dry-run] [--remove]
 *
 * Cell cycle cleanup — for each disabled oracle:
 *   1. Check repo exists locally
 *   2. Merge all branches → main
 *   3. Commit uncommitted work
 *   4. Push to remote
 *   5. Optionally remove .disabled fleet config (--remove)
 */

interface ConsolidateResult {
  name: string;
  num: string;
  repo: string;
  repoExists: boolean;
  branches: string[];
  merged: string[];
  pushOk: boolean;
  removed: boolean;
  error?: string;
}

export async function cmdFleetConsolidate(opts: { dryRun?: boolean; remove?: boolean } = {}) {
  const reposRoot = join(getGhqRoot(), "github.com");
  const disabledFiles = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).sort();

  if (disabledFiles.length === 0) {
    console.log("\n  \x1b[32m✓\x1b[0m No disabled oracles to consolidate.\n");
    return;
  }

  console.log(`\n  \x1b[36m🧹 Fleet Consolidate\x1b[0m${opts.dryRun ? " \x1b[33m(dry run)\x1b[0m" : ""}\n`);
  console.log(`  ${disabledFiles.length} disabled oracles to process\n`);

  const results: ConsolidateResult[] = [];

  for (const f of disabledFiles) {
    const dName = f.replace(/^\d+-/, "").replace(".json.disabled", "");
    const num = f.match(/^(\d+)/)?.[1] || "?";

    let cfg: any;
    try {
      cfg = JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8"));
    } catch {
      console.log(`  \x1b[31m✗\x1b[0m ${num.padStart(2)}  ${dName} — can't read config`);
      results.push({ name: dName, num, repo: "?", repoExists: false, branches: [], merged: [], pushOk: false, removed: false, error: "bad config" });
      continue;
    }

    const repo = cfg.windows?.[0]?.repo || "";
    const repoPath = repo ? join(reposRoot, repo) : "";
    const repoExists = repoPath ? require("fs").existsSync(repoPath) : false;

    const result: ConsolidateResult = { name: dName, num, repo, repoExists, branches: [], merged: [], pushOk: false, removed: false };

    if (!repoExists) {
      console.log(`  \x1b[90m○\x1b[0m ${num.padStart(2)}  ${dName} — repo not found locally (${repo || "no repo"})`);
      results.push(result);
      continue;
    }

    // Get branches
    try {
      const branchRaw = await hostExec(`git -C '${repoPath}' branch --list --no-color 2>/dev/null`);
      result.branches = branchRaw.split("\n").map(b => b.replace(/^\*?\s+/, "").trim()).filter(b => b && b !== "main" && b !== "master");
    } catch {
      result.branches = [];
    }

    if (opts.dryRun) {
      console.log(`  \x1b[36m⬡\x1b[0m ${num.padStart(2)}  ${dName} — ${result.branches.length} branches to merge${opts.remove ? " + remove config" : ""}`);
      if (result.branches.length > 0) {
        console.log(`       \x1b[90m${result.branches.join(", ")}\x1b[0m`);
      }
      results.push(result);
      continue;
    }

    // Checkout main
    try {
      await hostExec(`git -C '${repoPath}' checkout main 2>/dev/null || git -C '${repoPath}' checkout master 2>/dev/null`);
    } catch {
      console.log(`  \x1b[31m✗\x1b[0m ${num.padStart(2)}  ${dName} — can't checkout main`);
      result.error = "checkout failed";
      results.push(result);
      continue;
    }

    // Merge branches
    for (const branch of result.branches) {
      try {
        await hostExec(`git -C '${repoPath}' merge --no-edit '${branch}' 2>/dev/null`);
        result.merged.push(branch);
      } catch {
        // Try to abort failed merge
        try { await hostExec(`git -C '${repoPath}' merge --abort 2>/dev/null`); } catch {}
      }
    }

    // Commit any uncommitted work
    try {
      const status = await hostExec(`git -C '${repoPath}' status --porcelain 2>/dev/null`);
      if (status.trim()) {
        await hostExec(`git -C '${repoPath}' add -A && git -C '${repoPath}' commit -m 'chore: consolidate before archive' 2>/dev/null`);
      }
    } catch {}

    // Push
    try {
      await hostExec(`git -C '${repoPath}' push 2>/dev/null`);
      result.pushOk = true;
    } catch {
      // Try pull --rebase then push
      try {
        await hostExec(`git -C '${repoPath}' pull --rebase 2>/dev/null && git -C '${repoPath}' push 2>/dev/null`);
        result.pushOk = true;
      } catch {
        result.pushOk = false;
      }
    }

    // Remove disabled config if requested
    if (opts.remove && result.pushOk) {
      try {
        unlinkSync(join(FLEET_DIR, f));
        result.removed = true;
      } catch {}
    }

    const mergeInfo = result.merged.length > 0 ? `${result.merged.length} merged` : "0 merged";
    const pushIcon = result.pushOk ? "\x1b[32m↑\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const removeIcon = result.removed ? " \x1b[90m(config removed)\x1b[0m" : "";
    console.log(`  ${pushIcon} ${num.padStart(2)}  ${dName} — ${result.branches.length} branches, ${mergeInfo}, push:${result.pushOk ? "ok" : "fail"}${removeIcon}`);

    results.push(result);
  }

  // Summary
  const noRepo = results.filter(r => !r.repoExists);
  console.log();

  if (opts.dryRun) {
    const withBranches = results.filter(r => r.branches.length > 0);
    const totalBranches = results.reduce((sum, r) => sum + r.branches.length, 0);
    console.log(`  \x1b[90m${results.length} disabled | ${totalBranches} branches to merge | ${noRepo.length} no local repo\x1b[0m`);
    console.log(`  \x1b[90m💡 Run without --dry-run to execute\x1b[0m`);
  } else {
    const pushed = results.filter(r => r.pushOk);
    const pushFail = results.filter(r => r.repoExists && !r.pushOk && !r.error);
    const removed = results.filter(r => r.removed);
    const totalMerged = results.reduce((sum, r) => sum + r.merged.length, 0);

    console.log(`  \x1b[90m${results.length} processed | ${pushed.length} pushed | ${totalMerged} branches merged | ${noRepo.length} no local repo | ${pushFail.length} push failed${removed.length > 0 ? ` | ${removed.length} configs removed` : ""}\x1b[0m`);

    if (pushFail.length > 0) {
      console.log(`  \x1b[33m⚠\x1b[0m Push failures: ${pushFail.map(r => r.name).join(", ")}`);
    }
    if (!opts.remove && pushed.length > 0) {
      console.log(`  \x1b[90m💡 Use --remove to delete .disabled configs after successful push\x1b[0m`);
    }
  }
  console.log();
}
