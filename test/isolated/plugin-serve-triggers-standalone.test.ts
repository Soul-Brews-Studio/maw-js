import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
let triggers: any[] = [];
let history: any[] = [];

mock.module("maw-js/sdk", () => ({
  getTriggers: () => triggers,
  getTriggerHistory: () => history,
  fire: async () => [],
}));

const plugin = await import("../../src/vendor/mpr-plugins/serve-triggers/index.ts?plugin-serve-triggers-standalone");

describe("serve-triggers plugin standalone boundary", () => {
  test("imports runtime reads through the SDK and serve route types only", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/serve-triggers/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "maw-js/plugin/types"');
    expect(source).toContain("ServeHttpRouteRegistrar");
    expectStandalonePluginBoundary({ plugin: "serve-triggers" });
  });

  test("builds the legacy GET /api/triggers response shape", () => {
    const response = plugin.buildTriggersReadResponse({
      getTriggers: () => [
        { on: "pr-merge", repo: "Soul-Brews-Studio/maw-js", action: "maw hey", name: "notify" },
        { on: "agent-idle", timeout: 60, action: "maw wake" },
      ],
      getTriggerHistory: () => [{
        index: 0,
        result: {
          trigger: { on: "pr-merge", action: "maw hey" },
          action: "maw hey",
          ok: true,
          output: "sent",
          ts: 123,
        },
      }],
    });

    expect(response).toEqual({
      total: 2,
      triggers: [
        {
          index: 0,
          on: "pr-merge",
          repo: "Soul-Brews-Studio/maw-js",
          timeout: null,
          action: "maw hey",
          name: "notify",
          lastFired: { ts: 123, ok: true, action: "maw hey", error: null },
        },
        {
          index: 1,
          on: "agent-idle",
          repo: null,
          timeout: 60,
          action: "maw wake",
          name: null,
          lastFired: null,
        },
      ],
    });
  });

  test("serve hook registers GET /api/triggers", async () => {
    triggers = [{ on: "issue-close", action: "maw done", repo: "repo", name: "done" }];
    history = [{ index: 0, result: { ts: 456, ok: false, action: "maw done", error: "boom" } }];
    const routes: Array<{ method: string; path: string; handler: (request: Request) => Response | Promise<Response> }> = [];

    plugin.serve({
      http: {
        route: (method, path, handler) => routes.push({ method, path, handler }),
      },
    });

    expect(routes.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/triggers"]);
    const res = await routes[0].handler(new Request("http://local/api/triggers"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: 1,
      triggers: [{
        index: 0,
        on: "issue-close",
        repo: "repo",
        timeout: null,
        action: "maw done",
        name: "done",
        lastFired: { ts: 456, ok: false, action: "maw done", error: "boom" },
      }],
    });
  });

  test("serve hook fails clearly without route registration context", () => {
    expect(() => plugin.serve({})).toThrow("serve-triggers requires serve http route registration");
  });
});
