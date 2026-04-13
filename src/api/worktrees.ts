import { Elysia, t} from "elysia";
import { scanWorktrees, cleanupWorktree } from "../worktrees";

export const worktreesApi = new Elysia();

worktreesApi.get("/worktrees", async ({ set }) => {
  try {
    return await scanWorktrees();
  } catch (e: any) {
    set.status = 500; return { error: e.message };
  }
});

worktreesApi.post("/worktrees/cleanup", async ({ body, set}) => {
  const { path } = body;
  if (!path) { set.status = 400; return { error: "path required" }; }
  try {
    const log = await cleanupWorktree(path);
    return { ok: true, log };
  } catch (e: any) {
    set.status = 500; return { error: e.message };
  }
}, {
  body: t.Object({ path: t.String() }),
});
