/**
 * `maw self-update` — pull origin into the local maw-js checkout and
 * re-bind via `bun link`.
 *
 * Distinct from `maw update`, which reinstalls a *published* ref globally
 * via `bun add -g`. This command operates on the local DEV checkout —
 * the one `bun link`'d to the global `maw` binary.
 *
 * Flags handled by index.ts; this module owns the sync logic.
 *
 * Test seam: all shell commands route through `runner.exec()`. The default
 * runner shells out for real; tests inject a fake runner that records
 * calls without touching the filesystem or network.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";

export interface SelfUpdateOptions {
  dryRun?: boolean;
  check?: boolean;
  branch?: string;
  force?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  exec(cmd: string, args: string[], opts?: { cwd?: string }): ExecResult;
}

export interface SelfUpdateResult {
  ok: boolean;
  exitCode?: number;
  output: string;
}

export function defaultRunner(): Runner {
  return {
    exec(cmd, args, opts) {
      const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf-8" });
      return {
        code: r.status ?? 1,
        stdout: (r.stdout ?? "").toString(),
        stderr: (r.stderr ?? "").toString(),
      };
    },
  };
}

/**
 * Resolve the canonical maw-js checkout root from the running module's
 * location. The plugin lives at:
 *   <repo>/src/commands/plugins/self-update/impl.ts
 * so four `..` jumps land at the repo root.
 */
export function resolveCheckoutDir(srcDir: string): string {
  return resolve(srcDir, "../../../..");
}

const DEFAULT_BRANCH = "alpha";

export async function runSelfUpdate(
  opts: SelfUpdateOptions,
  runner: Runner = defaultRunner(),
  checkoutDir?: string,
): Promise<SelfUpdateResult> {
  const out: string[] = [];
  const log = (s = ""): void => { out.push(s); };
  const finish = (ok: boolean, exitCode?: number): SelfUpdateResult => ({
    ok,
    exitCode,
    output: out.join("\n"),
  });

  const dir = checkoutDir ?? resolveCheckoutDir(import.meta.dir);
  const branch = opts.branch || DEFAULT_BRANCH;

  if (!existsSync(join(dir, ".git"))) {
    log(`✗ not a git checkout: ${dir}`);
    log(`  maw self-update only works in a dev checkout (bun-linked).`);
    return finish(false, 1);
  }

  // Current branch
  const cur = runner.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (cur.code !== 0) {
    log(`✗ git rev-parse failed: ${cur.stderr.trim() || "unknown error"}`);
    return finish(false, 1);
  }
  const currentBranch = cur.stdout.trim();
  if (currentBranch === "HEAD") {
    log(`✗ local is in detached HEAD state.`);
    log(`  Switch first:  git checkout ${branch}`);
    return finish(false, 1);
  }
  if (currentBranch !== branch) {
    log(`✗ local is on '${currentBranch}', target is '${branch}'.`);
    log(`  Refusing to auto-switch. Either:`);
    log(`    git checkout ${branch}                # switch local`);
    log(`    maw self-update --branch=${currentBranch}   # track current`);
    return finish(false, 1);
  }

  // Dirty check
  const dirty = runner.exec("git", ["status", "--porcelain"], { cwd: dir });
  if (dirty.code !== 0) {
    log(`✗ git status failed: ${dirty.stderr.trim() || "unknown error"}`);
    return finish(false, 1);
  }
  const isDirty = dirty.stdout.trim().length > 0;
  if (isDirty && !opts.force) {
    log(`✗ local checkout is dirty:`);
    for (const line of dirty.stdout.trim().split("\n").slice(0, 10)) {
      log(`    ${line}`);
    }
    log(``);
    log(`  Stash + retry:  maw self-update --force  (auto-stash + restore)`);
    log(`  Or commit/stash manually first.`);
    return finish(false, 1);
  }

  // Fetch
  if (!opts.dryRun) {
    const fetch = runner.exec("git", ["fetch", "origin", branch], { cwd: dir });
    if (fetch.code !== 0) {
      log(`✗ git fetch origin ${branch} failed:`);
      log(`  ${fetch.stderr.trim()}`);
      return finish(false, 1);
    }
  } else {
    // Still fetch — read-only network call — so --dry-run reports
    // accurate delta against latest origin.
    const fetch = runner.exec("git", ["fetch", "origin", branch], { cwd: dir });
    if (fetch.code !== 0) {
      log(`✗ git fetch origin ${branch} failed:`);
      log(`  ${fetch.stderr.trim()}`);
      return finish(false, 1);
    }
  }

  // Compute SHAs
  const beforeRev = runner.exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  const afterRev = runner.exec("git", ["rev-parse", `origin/${branch}`], { cwd: dir });
  if (beforeRev.code !== 0 || afterRev.code !== 0) {
    log(`✗ could not resolve HEAD or origin/${branch}`);
    return finish(false, 1);
  }
  const beforeSha = beforeRev.stdout.trim();
  const afterSha = afterRev.stdout.trim();

  if (beforeSha === afterSha) {
    log(`✓ already in sync with origin/${branch} (${beforeSha.slice(0, 7)})`);
    return finish(true, 0);
  }

  // Range subjects
  const logRes = runner.exec("git", ["log", "--oneline", `${beforeSha}..${afterSha}`], { cwd: dir });
  const subjects = logRes.code === 0
    ? logRes.stdout.trim().split("\n").filter(s => s.length > 0)
    : [];
  const count = subjects.length;

  if (opts.check) {
    log(`✗ local is ${count} commit${count === 1 ? "" : "s"} behind origin/${branch}`);
    log(`  ${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)}`);
    log(`  Run \`maw self-update\` to apply.`);
    return finish(false, 1);
  }

  log(`local is ${count} commit${count === 1 ? "" : "s"} behind origin/${branch}:`);
  for (const s of subjects.slice(0, 12)) log(`  ${s}`);
  if (subjects.length > 12) log(`  ... and ${subjects.length - 12} more`);
  log(``);

  if (opts.dryRun) {
    log(`✓ dry-run: would pull ${count} commit${count === 1 ? "" : "s"} (${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)})`);
    return finish(true, 0);
  }

  // Stash if --force + dirty
  let stashed = false;
  if (isDirty && opts.force) {
    log(`📦 stashing uncommitted changes (--force)...`);
    const stash = runner.exec(
      "git",
      ["stash", "push", "-u", "-m", "maw self-update auto-stash"],
      { cwd: dir },
    );
    if (stash.code !== 0) {
      log(`✗ git stash failed: ${stash.stderr.trim()}`);
      return finish(false, 1);
    }
    stashed = true;
  }

  // Pull --ff-only — NEVER auto-merge
  log(`📥 git pull --ff-only origin ${branch}...`);
  const pull = runner.exec("git", ["pull", "--ff-only", "origin", branch], { cwd: dir });
  if (pull.code !== 0) {
    log(`✗ git pull --ff-only failed (not a fast-forward?):`);
    log(`  ${pull.stderr.trim()}`);
    if (stashed) {
      const pop = runner.exec("git", ["stash", "pop"], { cwd: dir });
      if (pop.code === 0) log(`↺ restored stash`);
      else log(`⚠ stash still in stash list — recover with: git stash pop`);
    }
    return finish(false, 1);
  }

  // bun install if lockfile changed
  const diff = runner.exec(
    "git",
    ["diff", "--name-only", `${beforeSha}..${afterSha}`],
    { cwd: dir },
  );
  const changed = diff.code === 0 ? diff.stdout.split("\n").map(s => s.trim()) : [];
  const lockChanged = changed.some(p => p === "bun.lock" || p === "bun.lockb" || p === "package.json");
  if (lockChanged) {
    log(`📦 lockfile/package.json changed — bun install --frozen-lockfile...`);
    const inst = runner.exec("bun", ["install", "--frozen-lockfile"], { cwd: dir });
    if (inst.code !== 0) {
      log(`⚠ bun install --frozen-lockfile failed (non-fatal):`);
      log(`  ${inst.stderr.trim()}`);
    }
  }

  // bun link — re-bind (no-op if already linked)
  log(`🔗 bun link (re-binding)...`);
  const link = runner.exec("bun", ["link"], { cwd: dir });
  if (link.code !== 0) {
    log(`⚠ bun link failed (non-fatal):`);
    log(`  ${link.stderr.trim()}`);
  }

  // Restore stash
  if (stashed) {
    const pop = runner.exec("git", ["stash", "pop"], { cwd: dir });
    if (pop.code !== 0) {
      log(`⚠ git stash pop failed — your changes remain stashed.`);
      log(`  Recover: git stash list / git stash pop`);
    } else {
      log(`↺ restored stash`);
    }
  }

  log(``);
  log(`✓ ${beforeSha.slice(0, 7)} → ${afterSha.slice(0, 7)} (${count} commit${count === 1 ? "" : "s"})`);
  return finish(true, 0);
}
