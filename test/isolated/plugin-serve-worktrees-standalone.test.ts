import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");

let scans = 0;
let cleanups: string[] = [];
let scanError: Error | undefined;
let cleanupError: Error | undefined;

mock.module("maw-js/sdk", () => ({
  scanWorktrees: async () => {
    scans += 1;
    if (scanError) throw scanError;
    return [{ path: "/repo/.wt-demo", branch: "codex/demo", name: "demo" }];
  },
  cleanupWorktree: async (path: string) => {
    cleanups.push(path);
    if (cleanupError) throw cleanupError;
    return [`removed ${path}`];
  },
}));

const plugin = await import("../../src/vendor/mpr-plugins/serve-worktrees/index.ts?plugin-serve-worktrees-standalone");

async function json(response: Response): Promise<unknown> {
  return await response.json();
}

describe("serve-worktrees plugin standalone boundary (#2434)", () => {
  test("imports worktree operations only through the SDK and serve types", () => {
    expectStandalonePluginBoundary({ plugin: "serve-worktrees" });
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/serve-worktrees/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "maw-js/plugin/types"');
    expect(source).toContain("ServeHttpRouteRegistrar");
  });

  test("registers identical worktrees list and cleanup routes", async () => {
    scans = 0;
    cleanups = [];
    scanError = undefined;
    cleanupError = undefined;
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

    plugin.serve({
      http: {
        route(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
        },
      },
    });

    expect([...routes.keys()].sort()).toEqual([
      "GET /api/worktrees",
      "POST /api/worktrees/cleanup",
    ]);

    const list = await routes.get("GET /api/worktrees")!(new Request("http://local/api/worktrees"));
    expect(list.status).toBe(200);
    expect(await json(list)).toEqual([{ path: "/repo/.wt-demo", branch: "codex/demo", name: "demo" }]);

    const cleanup = await routes.get("POST /api/worktrees/cleanup")!(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      body: JSON.stringify({ path: "/repo/.wt-demo" }),
    }));
    expect(cleanup.status).toBe(200);
    expect(await json(cleanup)).toEqual({ ok: true, log: ["removed /repo/.wt-demo"] });
    expect(scans).toBe(1);
    expect(cleanups).toEqual(["/repo/.wt-demo"]);
  });

  test("preserves validation and failure response shapes", async () => {
    scanError = new Error("tmux unavailable");
    cleanupError = new Error("cleanup denied");
    const handlers = plugin.createWorktreesRouteHandlers();

    const list = await handlers.list(new Request("http://local/api/worktrees"));
    expect(list.status).toBe(500);
    expect(await json(list)).toEqual({ error: "tmux unavailable" });

    const missing = await handlers.cleanup(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      body: JSON.stringify({ path: "" }),
    }));
    expect(missing.status).toBe(400);
    expect(await json(missing)).toEqual({ error: "path required" });

    const cleanup = await handlers.cleanup(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      body: JSON.stringify({ path: "/repo/.wt-demo" }),
    }));
    expect(cleanup.status).toBe(500);
    expect(await json(cleanup)).toEqual({ error: "cleanup denied" });
  });
});
