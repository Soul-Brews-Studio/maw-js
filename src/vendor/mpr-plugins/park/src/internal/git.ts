/**
 * Direct git invocation in a working directory.
 *
 * Replaces `hostExec("git -C 'cwd' ...")` from maw-js's internal SDK with
 * argv-style `spawnSync("git", ["-C", cwd, ...])`. No shell, no `safeCwd`
 * escaping, immune to argv injection. stderr is silenced — many of these
 * calls are tolerant of "not a git dir" and similar non-fatal conditions.
 */
import { spawnSync } from "node:child_process";

/** Run `git` in `cwd` with the given subcommand + args. Returns trimmed stdout. */
export function gitInDir(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return "";
  return (r.stdout || "").trim();
}

/** Current branch in `cwd`, or empty string if not a git repo. */
export function gitBranch(cwd: string): string {
  return gitInDir(cwd, "branch", "--show-current");
}

/** One-line description of the most recent commit in `cwd`, or empty string. */
export function gitLastCommit(cwd: string): string {
  return gitInDir(cwd, "log", "-1", "--oneline");
}

/** `git status --short` lines as an array; empty array on any error. */
export function gitDirtyFiles(cwd: string): string[] {
  const out = gitInDir(cwd, "status", "--short");
  return out ? out.split("\n").map((l) => l.trim()) : [];
}
