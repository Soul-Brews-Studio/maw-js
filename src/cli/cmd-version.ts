import { execSync, spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";

export function getVersionString(): string {
  const pkg = require("../../package.json");
  let hash = "";
  try { hash = execSync("git rev-parse --short HEAD", { cwd: import.meta.dir, stdio: "pipe" }).toString().trim(); } catch {}
  let buildDate = "";
  try {
    const raw = execSync("git log -1 --format=%ci", { cwd: import.meta.dir, stdio: "pipe" }).toString().trim();
    const d = new Date(raw);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    buildDate = `${raw.slice(0, 10)} ${days[d.getDay()]} ${raw.slice(11, 16)}`;
  } catch {}

  let warning = "";
  try { warning = computeBehindWarning(import.meta.dir); } catch {}

  return `maw v${pkg.version}${hash ? ` (${hash})` : ""}${buildDate ? ` built ${buildDate}` : ""}${warning}`;
}

/**
 * Compute "⚠ local is N commits behind origin/<branch>" warning string,
 * or "" if not applicable.
 *
 * Cheap heuristic (#1271): only run if `.git/FETCH_HEAD` was modified
 * within the last hour — otherwise we'd risk a slow `git fetch` on every
 * `maw --version` invocation. This means the warning surfaces AFTER the
 * user (or another `maw` command) has fetched recently — common after
 * `maw self-update`, `maw fleet sync`, etc.
 */
export function computeBehindWarning(cwd: string): string {
  // Resolve the actual .git dir (handles worktrees where .git is a file).
  const gitDirRes = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (gitDirRes.status !== 0) return "";
  const gitDir = gitDirRes.stdout.trim();
  if (!gitDir) return "";

  // Resolve toplevel — used as cwd for the remaining git calls.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (top.status !== 0) return "";
  const root = top.stdout.trim();
  if (!root) return "";

  // Recency gate: only warn if fetch happened within the last hour.
  // FETCH_HEAD lives in the git dir (which may be a worktree's subdir).
  const fetchHead = join(gitDir, "FETCH_HEAD");
  if (!existsSync(fetchHead)) return "";
  const ageMs = Date.now() - statSync(fetchHead).mtimeMs;
  if (ageMs > 60 * 60 * 1000) return "";

  // Current branch
  const cur = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (cur.status !== 0) return "";
  const branch = cur.stdout.trim();
  if (!branch || branch === "HEAD") return "";

  // Count behind
  const cnt = spawnSync("git", ["rev-list", "--count", `HEAD..origin/${branch}`], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (cnt.status !== 0) return "";
  const n = parseInt(cnt.stdout.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return "";

  return `\n  \x1b[33m⚠\x1b[0m local is ${n} commit${n === 1 ? "" : "s"} behind origin/${branch} — run \`maw self-update\``;
}
