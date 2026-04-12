import { Hono } from "hono";
import { execFileSync } from "child_process";
import { realpathSync } from "fs";
import { scanWorktrees, cleanupWorktree } from "../worktrees";
import { loadConfig } from "../config";

export const worktreesApi = new Hono();

const TASK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

worktreesApi.get("/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

worktreesApi.post("/worktrees/create", async (c) => {
  const { repoPath, taskName } = await c.req.json();
  if (!repoPath || !taskName) return c.json({ error: "repoPath and taskName required" }, 400);

  if (!TASK_NAME_RE.test(taskName)) {
    return c.json({ error: "invalid taskName format" }, 400);
  }

  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  let realRepo: string;
  try { realRepo = realpathSync(repoPath); } catch { return c.json({ error: "repoPath does not exist" }, 400); }
  if (!realRepo.startsWith(ghqRoot)) return c.json({ error: "repoPath outside ghqRoot" }, 403);

  const branch = `agents/wt-${taskName}`;
  const wtPath = `${realRepo}.wt-${taskName}`;
  try {
    execFileSync("git", ["-C", realRepo, "worktree", "add", wtPath, "-b", branch], { stdio: "pipe" });
    return c.json({ ok: true, path: wtPath, branch });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
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
