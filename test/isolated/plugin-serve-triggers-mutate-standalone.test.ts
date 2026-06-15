import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
const fireCalls: Array<{ event: string; ctx: Record<string, unknown> }> = [];

mock.module("maw-js/sdk", () => ({
  fire: async (event: string, ctx: Record<string, unknown>) => {
    fireCalls.push({ event, ctx });
    return [
      {
        trigger: { on: event, action: "ok" },
        action: "ok",
        ok: true,
        output: "done",
        ts: 1,
      },
      {
        trigger: { on: event, action: "bad" },
        action: "bad",
        ok: false,
        error: "boom",
        ts: 2,
      },
    ];
  },
}));

const plugin = await import("../../src/vendor/mpr-plugins/serve-triggers-mutate/index.ts?plugin-serve-triggers-mutate-standalone");

describe("serve-triggers-mutate plugin standalone boundary", () => {
  test("imports runtime mutation through the SDK and serve route types only", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/serve-triggers-mutate/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "maw-js/plugin/types"');
    expectStandalonePluginBoundary({ plugin: "serve-triggers-mutate" });
  });

  test("POST /api/triggers/fire awaits fire results and preserves response shape", async () => {
    fireCalls.length = 0;
    const handlers = plugin.createTriggerMutateRouteHandlers();
    const res = await handlers.fire(new Request("http://local/api/triggers/fire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "issue-close",
        context: { repo: "Soul-Brews-Studio/maw-js", issue: "2443" },
      }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      event: "issue-close",
      fired: 2,
      results: [
        { action: "ok", ok: true, output: "done", error: null },
        { action: "bad", ok: false, output: null, error: "boom" },
      ],
    });
    expect(fireCalls).toEqual([{
      event: "issue-close",
      ctx: { repo: "Soul-Brews-Studio/maw-js", issue: "2443" },
    }]);
  });

  test("validates JSON body before firing", async () => {
    fireCalls.length = 0;
    const handlers = plugin.createTriggerMutateRouteHandlers();

    const missingEvent = await handlers.fire(new Request("http://local/api/triggers/fire", {
      method: "POST",
      body: JSON.stringify({ context: {} }),
    }));
    expect(missingEvent.status).toBe(400);
    expect(await missingEvent.json()).toEqual({ error: "event is required" });

    const invalidContext = await handlers.fire(new Request("http://local/api/triggers/fire", {
      method: "POST",
      body: JSON.stringify({ event: "issue-close", context: { issue: 2443 } }),
    }));
    expect(invalidContext.status).toBe(400);
    expect(await invalidContext.json()).toEqual({ error: "context must be an object of string values" });
    expect(fireCalls).toEqual([]);
  });

  test("serve hook registers POST /api/triggers/fire", async () => {
    const routes: Array<{ method: string; path: string; handler: (request: Request) => Response | Promise<Response> }> = [];
    plugin.serve({
      http: {
        route: (method, path, handler) => routes.push({ method, path, handler }),
      },
    });

    expect(routes.map(({ method, path }) => `${method} ${path}`)).toEqual(["POST /api/triggers/fire"]);
  });

  test("serve hook fails clearly without route registration context", () => {
    expect(() => plugin.serve({})).toThrow("serve-triggers-mutate requires serve http route registration");
  });
});
