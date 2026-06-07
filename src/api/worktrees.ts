import { Elysia, t} from "elysia";
import { scanWorktrees, cleanupWorktree } from "../core/fleet/worktrees";

export interface WorktreesApiDeps {
  scanWorktrees: typeof scanWorktrees;
  cleanupWorktree: typeof cleanupWorktree;
}

export function createWorktreesApi(deps: WorktreesApiDeps = {
  scanWorktrees,
  cleanupWorktree,
}) {
  const api = new Elysia();

  api.get("/worktrees", async ({ set }) => {
    try {
      return await deps.scanWorktrees();
    } catch (e: any) {
      set.status = 500; return { error: e.message };
    }
  });

  api.post("/worktrees/cleanup", async ({ body, set}) => {
    const { path } = body;
    if (!path) { set.status = 400; return { error: "path required" }; }
    try {
      const log = await deps.cleanupWorktree(path);
      return { ok: true, log };
    } catch (e: any) {
      set.status = 500; return { error: e.message };
    }
  }, {
    body: t.Object({ path: t.String() }),
  });

  return api;
}

export const worktreesApi = createWorktreesApi();
