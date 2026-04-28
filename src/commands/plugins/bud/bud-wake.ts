import { hostExec } from "../../../sdk";
import { cmdSoulSync } from "../soul-sync/impl";
import { cmdWake } from "../../shared/wake";
import { loadFleetEntries } from "../../shared/fleet-load";
import { FLEET_DIR } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
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
    repo?: string;
    split?: boolean;
    fast?: boolean;
  };
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
      const parentFile = join(FLEET_DIR, entry.file);
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
  const { shouldAutoWake } = await import("../../shared/should-auto-wake");
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
  if (opts.issue) {
    const { fetchIssuePrompt } = await import("../../shared/wake");
    wakeOpts.prompt = await fetchIssuePrompt(opts.issue, `${org}/${budRepoName}`);
    wakeOpts.task = `issue-${opts.issue}`;
  }
  if (opts.repo) {
    // Clone the target repo via ghq (resolve-first, no worktree).
    // Previously set wakeOpts.incubate which auto-created a worktree — see #271.
    const { ensureCloned } = await import("../../shared/wake-target");
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
      const { cmdSplit } = await import("../split/impl");
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
      const { syncDir } = await import("../soul-sync/impl");
      for (const sub of ["learnings", "retrospectives", "traces"]) {
        const src = join(localPsi, sub);
        const dst = join(psiDir, "memory", sub);
        if (existsSync(src)) { try { syncDir(src, dst); } catch {} }
      }
      console.log(`  \x1b[32m✓\x1b[0m copied local project ψ/ from ${opts.repo}`);
    }
  }
}
