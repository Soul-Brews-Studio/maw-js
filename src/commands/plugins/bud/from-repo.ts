/**
 * `maw bud --from-repo <target> --stem <stem>` — planner + orchestrator.
 *
 * SCOPE: local-path + URL clone + `--pr` + `--force` + `--from` lineage +
 * `--track-vault` + fleet-entry registration (#588). Deferred: --seed, sync_peers.
 * Writes live in from-repo-exec.ts; git/gh shell-outs in from-repo-git.ts;
 * fleet writes in from-repo-fleet.ts. Planner stays pure / read-only.
 *
 * Design: docs/bud/from-repo-design.md + docs/bud/from-repo-impl.md
 */

import { existsSync, statSync } from "fs";
import { join, isAbsolute } from "path";
import type { FromRepoOpts, InjectionAction, InjectionPlan } from "./types";
import { applyFromRepoInjection } from "./from-repo-exec";
import { cloneShallow, cleanupClone, branchCommitPushPR } from "./from-repo-git";
import { registerFleetEntry } from "./from-repo-fleet";
import { seedFromParent, copyPeersSnapshot } from "./from-repo-seed";

/** Heuristic: is `target` a URL or `org/repo` slug rather than a local path? */
export function looksLikeUrl(target: string): boolean {
  if (target.startsWith("http://") || target.startsWith("https://")) return true;
  if (target.startsWith("git@")) return true;
  // `org/repo` slug — exactly one slash, no leading dot/slash, no absolute path
  if (!isAbsolute(target) && !target.startsWith(".") && target.split("/").length === 2) return true;
  return false;
}

/** The directory tree that `ψ/` injection needs to create — mirrors bud-init.ts. */
const PSI_DIRS = [
  "ψ/memory/learnings",
  "ψ/memory/retrospectives",
  "ψ/memory/traces",
  "ψ/memory/resonance",
  "ψ/memory/collaborations",
  "ψ/inbox",
  "ψ/outbox",
  "ψ/plans",
];

/**
 * Compute the injection plan for a target repo. Pure / read-only —
 * never writes, never mutates. The returned plan is safe to print.
 *
 * Blockers are hard stops that the caller must refuse to proceed past.
 */
export function planFromRepoInjection(opts: FromRepoOpts): InjectionPlan {
  const blockers: string[] = [];
  const actions: InjectionAction[] = [];

  // URL / slug targets: the orchestrator resolves them to a tmpdir via
  // cloneShallow and calls the planner again with isUrl=false. If a URL
  // reaches the planner directly, it's a dry-run — surface a blocker so
  // we don't attempt a clone during a read-only preview.
  if (opts.isUrl) {
    blockers.push(
      `URL / org-slug dry-run not supported — clone would be a side effect. Re-run without --dry-run.`,
    );
    return { target: opts.target, stem: opts.stem, actions, blockers };
  }

  const target = opts.target;
  if (!existsSync(target)) {
    blockers.push(`target path does not exist: ${target}`);
    return { target, stem: opts.stem, actions, blockers };
  }
  if (!statSync(target).isDirectory()) {
    blockers.push(`target is not a directory: ${target}`);
    return { target, stem: opts.stem, actions, blockers };
  }
  if (!existsSync(join(target, ".git"))) {
    blockers.push(`target is not a git repo (no .git): ${target}`);
    return { target, stem: opts.stem, actions, blockers };
  }

  // Collision: ψ/ already present. --force downgrades the blocker to a warning.
  const psiExists = existsSync(join(target, "ψ"));
  if (psiExists && !opts.force) {
    blockers.push(
      `ψ/ already present at ${target} — looks like an existing oracle repo. Use maw soul-sync, maw wake, or pass --force to merge into the existing vault.`,
    );
    return { target, stem: opts.stem, actions, blockers };
  }

  // 1. ψ/ vault directories
  for (const d of PSI_DIRS) {
    actions.push({
      kind: "mkdir",
      path: d,
      reason: psiExists ? "ψ/ exists — --force: mkdir is idempotent, merge into existing vault" : undefined,
    });
  }

  // 2. CLAUDE.md — write if absent, append if present
  const claudePath = join(target, "CLAUDE.md");
  if (existsSync(claudePath)) {
    actions.push({
      kind: "append",
      path: "CLAUDE.md",
      reason: "exists — will append ## Oracle scaffolding section (never overwrite)",
    });
  } else {
    actions.push({
      kind: "write",
      path: "CLAUDE.md",
      reason: "absent — will write full oracle identity + Rule 6 template",
    });
  }

  // 3. .claude/settings.local.json — minimal, only if absent
  const settingsPath = join(target, ".claude", "settings.local.json");
  if (existsSync(settingsPath)) {
    actions.push({ kind: "skip", path: ".claude/settings.local.json", reason: "exists — leave untouched" });
  } else {
    actions.push({ kind: "write", path: ".claude/settings.local.json", reason: "empty {} scaffold" });
  }

  // 4. .gitignore — append `ψ/` unless --track-vault. Idempotent; reflected in
  //    plan even if the line is already present (executor de-dupes).
  if (opts.trackVault) {
    actions.push({
      kind: "skip",
      path: ".gitignore",
      reason: "--track-vault — leaving ψ/ unignored",
    });
  } else {
    actions.push({
      kind: "append",
      path: ".gitignore",
      reason: "add `ψ/` (default; pass --track-vault to keep ψ/ tracked)",
    });
  }

  // 5. fleet entry — registered after the executor lands. Plan reflects intent.
  actions.push({
    kind: "write",
    path: `fleet/<NN>-${opts.stem}.json`,
    reason: opts.from
      ? `register in ~/.config/maw/fleet/ with budded_from=${opts.from}`
      : "register in ~/.config/maw/fleet/",
  });

  // 6. --seed: pre-load parent's ψ/memory (#588 final pair). Requires --from.
  if (opts.seed) {
    if (opts.from) {
      actions.push({
        kind: "write",
        path: "ψ/memory/ (seeded from parent)",
        reason: `--seed: copy ${opts.from}'s ψ/memory/ into target (dest-biased, no overwrite)`,
      });
    } else {
      actions.push({
        kind: "skip",
        path: "ψ/memory/ (seed)",
        reason: "--seed requires --from <parent> — nothing to seed from",
      });
    }
  }

  // 7. --sync-peers: snapshot host peers.json into target. Non-destructive.
  if (opts.syncPeers) {
    actions.push({
      kind: "write",
      path: "ψ/peers.json",
      reason: "--sync-peers: snapshot host peers.json (portable seed, no ~/.maw/ mutation)",
    });
  }

  return { target, stem: opts.stem, actions, blockers };
}

/** Render the plan for human reading. Caller prints — no side effects here. */
export function formatPlan(plan: InjectionPlan): string {
  const lines: string[] = [];
  lines.push(`\n  \x1b[36m🧪 Oracle scaffold plan\x1b[0m — ${plan.stem} → ${plan.target}\n`);
  if (plan.blockers.length > 0) {
    lines.push(`  \x1b[31m✗ blocked:\x1b[0m`);
    for (const b of plan.blockers) lines.push(`    - ${b}`);
    return lines.join("\n") + "\n";
  }
  for (const a of plan.actions) {
    const tag = a.kind === "mkdir" ? "mkdir" : a.kind === "write" ? "write" : a.kind === "append" ? "append" : "skip ";
    const color = a.kind === "skip" ? "\x1b[90m" : "\x1b[36m";
    const reason = a.reason ? `  \x1b[90m(${a.reason})\x1b[0m` : "";
    lines.push(`  ${color}${tag}\x1b[0m  ${a.path}${reason}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Orchestrator.
 * - Dry-run (local only): print the plan and return.
 * - Local path: print plan, apply injection; if --pr, open PR afterwards.
 * - URL / slug: shallow-clone → tmpdir, delegate to local-path flow, always
 *   open PR (the tmpdir is ephemeral so committing-only would be lost),
 *   cleanup tmpdir on both success and failure.
 */
export async function cmdBudFromRepo(opts: FromRepoOpts): Promise<void> {
  if (opts.isUrl) {
    if (opts.dryRun) {
      // Preserve the dry-run safety rail (planner surfaces the blocker).
      const plan = planFromRepoInjection(opts);
      console.log(formatPlan(plan));
      throw new Error(`plan has ${plan.blockers.length} blocker(s) — see above`);
    }
    console.log(`\n  \x1b[36m⚡\x1b[0m cloning ${opts.target}...`);
    const tmp = await cloneShallow(opts.target);
    console.log(`  \x1b[32m✓\x1b[0m cloned → ${tmp}`);
    const localOpts: FromRepoOpts = { ...opts, target: tmp, isUrl: false, pr: true };
    try {
      await runLocal(localOpts);
    } finally {
      cleanupClone(tmp);
      console.log(`  \x1b[90m○\x1b[0m cleaned up temp clone`);
    }
    return;
  }
  await runLocal(opts);
}

/** Local-path path — also used after URL clone. */
async function runLocal(opts: FromRepoOpts): Promise<void> {
  const plan = planFromRepoInjection(opts);
  console.log(formatPlan(plan));
  if (plan.blockers.length > 0) {
    throw new Error(`plan has ${plan.blockers.length} blocker(s) — see above`);
  }
  if (opts.dryRun) return;
  await applyFromRepoInjection(plan, opts);
  // --seed: pre-load parent's ψ/memory/ after the vault exists. Requires --from.
  if (opts.seed) {
    if (!opts.from) {
      console.log(`  \x1b[33m!\x1b[0m --seed ignored (no --from <parent> to seed from)`);
    } else {
      try {
        seedFromParent(opts.target, opts.from, (m) => console.log(m));
      } catch (e: any) {
        console.log(`  \x1b[33m!\x1b[0m --seed failed: ${e.message} — injection still complete`);
      }
    }
  }
  // --sync-peers: snapshot host peers.json into target vault.
  if (opts.syncPeers) {
    try {
      copyPeersSnapshot(opts.target, (m) => console.log(m));
    } catch (e: any) {
      console.log(`  \x1b[33m!\x1b[0m --sync-peers failed: ${e.message} — injection still complete`);
    }
  }
  // Fleet entry — register the budded oracle so `maw wake <stem>` works.
  // Failure to register is logged but never blocks the injection (the repo
  // is the canonical artifact; fleet is a convenience index).
  try {
    const result = registerFleetEntry({ stem: opts.stem, target: opts.target, parent: opts.from });
    const verb = result.created ? "registered" : "updated";
    console.log(`  \x1b[32m✓\x1b[0m fleet entry ${verb}: ${result.file}`);
  } catch (e: any) {
    console.log(`  \x1b[33m!\x1b[0m fleet entry skipped: ${e.message}`);
  }
  if (opts.pr) {
    const url = await branchCommitPushPR(opts.target, opts.stem, (m) => console.log(m));
    console.log(`\n  \x1b[32m🎉 PR opened:\x1b[0m ${url}\n`);
  }
}
