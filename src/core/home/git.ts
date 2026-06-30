/**
 * Thin argv-style git/gh runners for the Company Home repo (ADR 0002).
 *
 * spawnSync (no shell) so a company name or path can never inject argv — same
 * stance as the park plugin's gitInDir. Unlike park we KEEP stderr + status so
 * the `maw home` verbs can tell "nothing to commit" (benign) from a real push
 * failure and surface a clear message. Both runners are injectable on the store
 * functions so unit tests drive the orchestration without touching real git/gh.
 */

import { spawnSync } from "node:child_process";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run `git` inside `cwd`. Never throws — inspect `.ok` / `.stderr`. */
export function runGit(cwd: string, args: string[]): RunResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status,
  };
}

/** Run `gh` (optionally in `cwd`). Never throws — inspect `.ok` / `.stderr`. */
export function runGh(args: string[], cwd?: string): RunResult {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status,
  };
}

export type GitRunner = (cwd: string, args: string[]) => RunResult;
export type GhRunner = (args: string[], cwd?: string) => RunResult;
