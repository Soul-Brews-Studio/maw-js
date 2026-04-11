import { Hono } from "hono";
import { join, resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { scanWorktrees, cleanupWorktree } from "../worktrees";
import { loadConfig } from "../config";

// Strict whitelist for client-supplied task names. No shell metacharacters,
// no slashes, no leading/trailing whitespace, bounded length. Paired with
// the repoPath whitelist below to make the /worktrees/create handler
// argv-safe even before execFileSync closes the shell-interpolation vector.
const TASK_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const worktreesApi = new Hono();

worktreesApi.get("/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

worktreesApi.post("/worktrees/create", async (c) => {
  let body: { taskName?: unknown; repoPath?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate taskName: strict whitelist regex. Rejects anything with shell
  // metacharacters, slashes, or whitespace before it can touch git or the
  // filesystem. Does not echo the raw value back (NEW-13 pattern).
  if (typeof body.taskName !== "string" || !TASK_NAME_RE.test(body.taskName)) {
    return c.json({ error: "taskName must match [a-zA-Z0-9_-]{1,64}" }, 400);
  }
  const taskName = body.taskName;

  // Validate repoPath: canonicalize, confirm under ghqRoot, confirm it is a
  // real git directory. Canonicalization resolves `.` / `..` and symlinks
  // relative to the server's cwd; the startsWith check uses the canonical
  // ghqRoot with a trailing separator so a sibling directory like
  // "<ghqRoot>-evil" cannot pass the prefix test.
  const rawRepoPath = typeof body.repoPath === "string" && body.repoPath.length > 0
    ? body.repoPath
    : process.cwd();
  const cwd = resolve(rawRepoPath);
  const ghqRoot = resolve(loadConfig().ghqRoot);
  if (cwd !== ghqRoot && !cwd.startsWith(ghqRoot + "/")) {
    return c.json({ error: "repoPath must be inside ghqRoot" }, 400);
  }
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return c.json({ error: "repoPath is not a git repository" }, 400);
  }

  const branch = `task/${taskName}-${Date.now().toString(36)}`;
  const wtPath = join(homedir(), `.maw/worktrees/${branch.replace(/\//g, "-")}`);

  try {
    // argv form — no shell interpretation, metacharacters in any argument
    // are passed as literal bytes to git. Replaces the previous execSync
    // shell-string interpolation of client-supplied repoPath and taskName.
    execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { stdio: "pipe" });
    mkdirSync(join(homedir(), ".maw/worktrees"), { recursive: true });
    execFileSync("git", ["-C", cwd, "worktree", "add", wtPath, "-b", branch], { stdio: "pipe" });
    return c.json({ ok: true, path: wtPath, branch, repoPath: cwd });
  } catch {
    // Deliberately do not echo e.message or any raw body field: git errors
    // can contain user-supplied substrings and this is an unauth-adjacent
    // endpoint. The real error is still in the server logs via Bun.
    return c.json({ error: "Failed to create worktree" }, 500);
  }
});

worktreesApi.post("/worktrees/cleanup", async (c) => {
  const { path } = await c.req.json();
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    const log = await cleanupWorktree(path);
    return c.json({ ok: true, log });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
