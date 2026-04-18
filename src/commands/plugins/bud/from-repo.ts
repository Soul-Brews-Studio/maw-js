/**
 * `maw bud --from-repo <target> --stem <stem>` — scaffold-only implementation.
 *
 * SCOPE (this PR, #588): planning + dry-run printing only. Any non-dry-run
 * invocation exits with "not yet implemented — see #588". No filesystem
 * writes happen from this module in any path.
 *
 * Design: docs/bud/from-repo-design.md
 */

import { existsSync, statSync } from "fs";
import { join, isAbsolute } from "path";
import type { FromRepoOpts, InjectionAction, InjectionPlan } from "./types";

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

  if (opts.isUrl) {
    blockers.push(
      `URL / org-slug targets not yet supported — see #588 TODO. Pass a local path for dry-run.`,
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

  // Collision: ψ/ already present
  if (existsSync(join(target, "ψ"))) {
    blockers.push(
      `ψ/ already present at ${target} — looks like an existing oracle repo. Use maw soul-sync or maw wake.`,
    );
    return { target, stem: opts.stem, actions, blockers };
  }

  // 1. ψ/ vault directories
  for (const d of PSI_DIRS) {
    actions.push({ kind: "mkdir", path: d });
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

  // 4. fleet entry — deferred; listed as skip so operators see the gap
  actions.push({
    kind: "skip",
    path: `fleet/<NN>-${opts.stem}.json`,
    reason: "fleet entry creation deferred to follow-up PR (#588)",
  });

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
 * Orchestrator. Dry-run: print the plan. Non-dry-run: refuse with a pointer
 * to #588 — the actual write path is a follow-up PR.
 */
export async function cmdBudFromRepo(opts: FromRepoOpts): Promise<void> {
  const plan = planFromRepoInjection(opts);
  if (opts.dryRun) {
    console.log(formatPlan(plan));
    if (plan.blockers.length > 0) {
      throw new Error(`plan has ${plan.blockers.length} blocker(s) — see above`);
    }
    return;
  }
  throw new Error(
    `maw bud --from-repo: not yet implemented — see #588.\n` +
    `  Re-run with --dry-run to preview the injection plan.`,
  );
}
