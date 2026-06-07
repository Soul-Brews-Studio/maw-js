import { cleanupWorktree, scanWorktrees } from "maw-js/sdk";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type WorktreesDeps = {
  scanWorktrees: typeof scanWorktrees;
  cleanupWorktree: typeof cleanupWorktree;
};

type ServeWorktreesContext = {
  http?: ServeHttpRouteRegistrar;
};

const defaultDeps: WorktreesDeps = {
  scanWorktrees,
  cleanupWorktree,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createWorktreesRouteHandlers(deps: WorktreesDeps = defaultDeps) {
  return {
    list: async () => {
      try {
        return Response.json(await deps.scanWorktrees());
      } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
      }
    },
    cleanup: async (request: Request) => {
      const body = await readJsonBody(request) as { path?: unknown } | undefined;
      const path = typeof body?.path === "string" ? body.path : "";
      if (!path) return Response.json({ error: "path required" }, { status: 400 });
      try {
        const log = await deps.cleanupWorktree(path);
        return Response.json({ ok: true, log });
      } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
      }
    },
  };
}

export function registerWorktreesRoutes(http: ServeHttpRouteRegistrar, deps?: WorktreesDeps): void {
  const handlers = createWorktreesRouteHandlers(deps);
  http.route("GET", "/api/worktrees", handlers.list);
  http.route("POST", "/api/worktrees/cleanup", handlers.cleanup);
}

export function serve(ctx: ServeWorktreesContext): void {
  if (!ctx.http) throw new Error("serve-worktrees requires serve http route registration");
  registerWorktreesRoutes(ctx.http);
}

export default serve;
