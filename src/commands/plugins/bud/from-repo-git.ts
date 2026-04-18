/**
 * Git + gh shell-outs for `maw bud --from-repo` (#588).
 *
 * Only module that shells out for git/gh. Kept small so tests can
 * swap the whole module via `mock.module("./from-repo-git", …)`.
 *
 * Design: docs/bud/from-repo-impl.md sections (c) and (g).
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hostExec } from "../../../sdk";

/** Single-quote escape for bash. Safe for unknown input (URLs, paths, branches). */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Deterministic branch name for the scaffold PR. */
export function scaffoldBranchName(stem: string): string {
  return `oracle/scaffold-${stem}`;
}

/**
 * `git clone --depth 1 <url> <tmpdir>` — returns the tmpdir path.
 *
 * On clone failure the tmpdir is removed before the error bubbles, so
 * the caller never has to clean up a half-cloned tree.
 */
export async function cloneShallow(url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "maw-bud-from-repo-"));
  try {
    await hostExec(`git clone --depth 1 ${sh(url)} ${sh(dir)}`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/** Recursively `rmSync` a tmpdir. Idempotent — never throws on missing. */
export function cleanupClone(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Log callback shape — mirrors from-repo-exec.ts. */
type Log = (msg: string) => void;

/**
 * After injection: branch → add → commit → push → `gh pr create`.
 * Returns the PR URL printed by gh.
 *
 * No rollback on failure: the operator owns git state. If push or
 * `gh pr create` fails the branch stays local, fully committed; re-run
 * after fixing the underlying cause (auth, remote, etc).
 */
export async function branchCommitPushPR(
  cwd: string,
  stem: string,
  log: Log,
): Promise<string> {
  const branch = scaffoldBranchName(stem);
  const cd = `cd ${sh(cwd)}`;
  const msg = `oracle: scaffold from maw bud --from-repo (stem=${stem})`;

  log(`  \x1b[36m⏳\x1b[0m creating branch ${branch}...`);
  await hostExec(`${cd} && git checkout -b ${sh(branch)}`);
  await hostExec(`${cd} && git add -A`);
  await hostExec(`${cd} && git commit -m ${sh(msg)}`);
  log(`  \x1b[32m✓\x1b[0m commit created on ${branch}`);

  log(`  \x1b[36m⏳\x1b[0m pushing ${branch} to origin...`);
  await hostExec(`${cd} && git push -u origin ${sh(branch)}`);

  log(`  \x1b[36m⏳\x1b[0m opening PR via gh...`);
  const out = await hostExec(`${cd} && gh pr create --fill --head ${sh(branch)}`);
  const prUrl = extractPrUrl(out);
  log(`  \x1b[32m✓\x1b[0m PR opened: ${prUrl}`);
  return prUrl;
}

/** Pull the first `https://…` URL out of gh's output. Falls back to trimmed output. */
function extractPrUrl(out: string): string {
  const m = out.match(/https?:\/\/\S+/);
  return m ? m[0] : out.trim();
}
