import {
  cmdSplit, cmdWake, ensureCloned, fetchIssuePrompt, fleetLoadDirForWrite, getGhqRoot, hostExec,
  loadFleetCore as loadFleet, loadFleetEntries, shouldAutoWake,
} from "maw-js/sdk";
import { cmdSoulSync } from "./internal/soul-sync-impl";
import { resolveOraclePath } from "./internal/resolve";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

export interface BudFinalizeCtx {
  name: string;
  parentName: string | null;
  org: string;
  budRepoName: string;
  budRepoPath: string;
  psiDir: string;
  fleetFile: string;
  opts: {
    seed?: boolean;
    issue?: number;
    /** #1912 — explicit issue-repo override (owner/repo). */
    issueRepo?: string;
    repo?: string;
    split?: boolean;
    fast?: boolean;
    parentSessionId?: string;
    sessionId?: string;
  };
}

/**
 * #1912 — resolve the GitHub `owner/repo` slug to use for the --issue
 * lookup at bud-wake time.
 *
 * Priority:
 *   1. ctx.opts.issueRepo (explicit override)
 *   2. Parent oracle's repo when ctx.parentName is set:
 *        a. Fleet config (authoritative — windows[].repo is "owner/repo")
 *        b. Local clone's git origin remote (parse owner/repo from URL)
 *        c. Last-resort fallback: {ctx.org}/{parent}-oracle (warn the operator)
 *   3. ctx.org/{budRepoName} — current behavior (useful when bud is seeded
 *      with starter issues; preserved for back-compat)
 *
 * @internal — exported for tests.
 */
export async function resolveIssueRepoForBud(ctx: BudFinalizeCtx): Promise<string> {
  const { opts, parentName, org, budRepoName } = ctx;
  if (opts.issueRepo) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.issueRepo)) {
      throw new Error(`bud: --issue-repo must be 'owner/repo' format — got '${opts.issueRepo}'`);
    }
    return opts.issueRepo;
  }
  if (!parentName) return `${org}/${budRepoName}`;

  // (2a) Fleet config — windows[].repo is "owner/repo".
  try {
    const fleet = loadFleet();
    for (const sess of fleet) {
      const win = (sess.windows || []).find(w => w.name === `${parentName}-oracle` || w.name === parentName);
      if (win?.repo) return win.repo;
    }
  } catch { /* fleet load failed — fall through */ }

  // (2b) Local clone's git remote.
  try {
    const localPath = await resolveOraclePath(parentName);
    if (localPath) {
      const remote = await hostExec(`git -C '${localPath.replace(/'/g, "'\\''")}' remote get-url origin`);
      const m = remote.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* remote inspection failed — fall through */ }

  // (2c) Last resort.
  console.log(`  \x1b[33m⚠\x1b[0m --issue-repo not set and parent '${parentName}' repo not in fleet/local; falling back to '${org}/${parentName}-oracle'. Use --issue-repo to override.`);
  return `${org}/${parentName}-oracle`;
}

/** Steps 5-8.5: soul-sync, initial commit, sync_peers update, wake, split, copy ψ/. */
export async function finalizeBud(ctx: BudFinalizeCtx): Promise<void> {
  const { name, parentName, org, budRepoName, budRepoPath, psiDir, opts } = ctx;
  const reposRoot = join(getGhqRoot(), "github.com");

  // 5. Soul-sync: consent-based model.
  // Default: born blank — child pulls memory later via `maw soul-sync <parent> --from`.
  // Opt-in: --seed explicitly requests bulk push from parent at birth.
  // Legacy: --blank still accepted (no-op, birth is already blank by default).
  if (opts.seed && parentName) {
    console.log(`  \x1b[36m⏳\x1b[0m --seed: bulk soul-sync from ${parentName}...`);
    try {
      await cmdSoulSync(parentName, { from: true, cwd: budRepoPath });
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m soul-sync seed failed (parent may have empty ψ/)`);
    }
  } else if (parentName) {
    console.log(`  \x1b[90m○\x1b[0m born blank — pull memory when ready: maw soul-sync ${parentName} --from`);
  } else {
    console.log(`  \x1b[90m○\x1b[0m root oracle — no parent`);
  }

  // 6. Initial git commit + push
  try {
    await hostExec(`git -C '${budRepoPath}' add -A`);
    await hostExec(`git -C '${budRepoPath}' commit -m 'feat: birth — ${parentName ? `budded from ${parentName}` : "root oracle"}'`);
    await hostExec(`git -C '${budRepoPath}' push -u origin HEAD`);
    console.log(`  \x1b[32m✓\x1b[0m initial commit pushed`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m git push failed (may need manual setup)`);
  }

  // 7. Update parent's sync_peers (skip for root buds)
  if (!parentName) {
    console.log(`  \x1b[90m○\x1b[0m root oracle — no parent sync_peers to update`);
  }
  for (const entry of parentName ? loadFleetEntries() : []) {
    const entryName = entry.session.name.replace(/^\d+-/, "");
    if (entryName === parentName) {
      const parentFile = entry.path ?? join(fleetLoadDirForWrite(), entry.file);
      const parentConfig = JSON.parse(readFileSync(parentFile, "utf-8"));
      const peers: string[] = parentConfig.sync_peers || [];
      if (!peers.includes(name)) {
        peers.push(name);
        parentConfig.sync_peers = peers;
        writeFileSync(parentFile, JSON.stringify(parentConfig, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m added ${name} to ${parentName}'s sync_peers`);
      }
      break;
    }
  }

  // 8. Wake the bud
  // #835 — consult unified shouldAutoWake helper. bud's policy is "always
  // wake" — a freshly-cloned bud has no session yet and the whole point of
  // bud is to spawn one. The helper makes that explicit and auditable.
  const decision = shouldAutoWake(name, { site: "bud" });
  if (!decision.wake) {
    // Defensive — site=bud never returns wake=false today. Preserve the
    // future-policy escape hatch with a clear log.
    console.log(`  \x1b[33m⚠\x1b[0m wake skipped: ${decision.reason}`);
    return;
  }
  console.log(`  \x1b[36m⏳\x1b[0m waking ${name}...`);
  // #421 — pass the exact cloned path so wake doesn't re-resolve via ghqFind,
  // which would match any same-named repo in any org (stale-clone bug).
  const wakeOpts: any = { noAttach: true, repoPath: budRepoPath };
  if (opts.parentSessionId) wakeOpts.parentSessionId = opts.parentSessionId;
  if (opts.sessionId) wakeOpts.sessionId = opts.sessionId;
  if (opts.issue) {
    const issueRepo = await resolveIssueRepoForBud(ctx);
    wakeOpts.prompt = await fetchIssuePrompt(opts.issue, issueRepo);
    wakeOpts.task = `issue-${opts.issue}`;
  }
  if (opts.repo) {
    // Clone the target repo via ghq (resolve-first, no worktree).
    // Previously set wakeOpts.incubate which auto-created a worktree — see #271.
    await ensureCloned(opts.repo);
  }
  try {
    await cmdWake(name, wakeOpts);
    console.log(`  \x1b[32m✓\x1b[0m ${name} is alive`);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m wake failed: ${e.message || e}`);
    console.log(`  \x1b[90m  try: maw wake ${name}\x1b[0m`);
  }

  // 8.25. Optional --split: show the child in a right-side pane so parent watches it awaken.
  // Delegates to cmdSplit — single canonical impl, so the TMUX= env-inheritance fix
  // applies here automatically. Previously inlined the tmux shell-out which silently
  // failed inside tmux (nested attach-session refused to nest, pane died immediately).
  if (opts.split && process.env.TMUX) {
    try {
      await cmdSplit(name);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m split failed: ${e.message || e}`);
    }
  } else if (opts.split && !process.env.TMUX) {
    console.log(`  \x1b[33m⚠\x1b[0m --split requires tmux session (TMUX env var not set)`);
  }

  // 8.5. Copy local project ψ/ if --repo was used and it exists
  if (opts.repo) {
    const localPsi = join(reposRoot, opts.repo, "ψ", "memory");
    if (existsSync(localPsi)) {
      const { syncDir } = await import("./internal/soul-sync-impl");
      for (const sub of ["learnings", "retrospectives", "traces"]) {
        const src = join(localPsi, sub);
        const dst = join(psiDir, "memory", sub);
        if (existsSync(src)) { try { syncDir(src, dst); } catch {} }
      }
      console.log(`  \x1b[32m✓\x1b[0m copied local project ψ/ from ${opts.repo}`);
    }
  }
}
