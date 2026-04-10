import { Hono } from "hono";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { execSync } from "child_process";
import { scanWorktrees, cleanupWorktree } from "../worktrees";

export const worktreesApi = new Hono();

worktreesApi.get("/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

worktreesApi.post("/worktrees/create", async (c) => {
  let body: { taskName?: string; repoPath?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const taskName = body.taskName;
  if (!taskName) return c.json({ error: "taskName required" }, 400);

  const branch = `task/${taskName}-${Date.now().toString(36)}`;
  const wtPath = join(homedir(), `.maw/worktrees/${branch.replace(/\//g, "-")}`);

  try {
    const cwd = body.repoPath || process.cwd();
    execSync(`git -C "${cwd}" rev-parse --git-dir`, { stdio: "pipe" });
    mkdirSync(join(homedir(), ".maw/worktrees"), { recursive: true });
    execSync(`git -C "${cwd}" worktree add "${wtPath}" -b "${branch}"`, { stdio: "pipe" });
    return c.json({ ok: true, path: wtPath, branch, repoPath: cwd });
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to create worktree" }, 500);
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
