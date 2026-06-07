import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
let listAllError: Error | undefined;
let listPanesError: Error | undefined;

function buildRows(
  panes: Array<{ command: string; target: string; pid?: number }>,
  windowNames: Map<string, string>,
  node: string,
  opts: { all?: boolean } = {},
) {
  return panes.flatMap((pane) => {
    const match = pane.target.match(/^(.+):(.+)\.\d+$/);
    if (!match) return [];
    const [, session, winPart] = match;
    const window = /^\d+$/.test(winPart) ? windowNames.get(`${session}:${winPart}`) ?? "" : winPart;
    const oracle = window.endsWith("-oracle") ? window.slice(0, -"-oracle".length) : "";
    if (!opts.all && !oracle) return [];
    return [{
      node,
      session,
      window,
      oracle,
      state: ["zsh", "bash", "sh", "fish", "dash"].includes(pane.command.toLowerCase()) ? "idle" : "active",
      pid: pane.pid ?? null,
    }];
  });
}

mock.module("maw-js/sdk", () => ({
  loadConfig: () => ({ node: "test-node" }),
  tmux: {
    listAll: async () => {
      if (listAllError) throw listAllError;
      return [
        { name: "01-mawjs", windows: [{ index: "0", name: "mawjs-oracle" }] },
        { name: "02-neo", windows: [{ index: "0", name: "neo-oracle" }, { index: "1", name: "shell" }] },
      ];
    },
    listPanes: async () => {
      if (listPanesError) throw listPanesError;
      return [
        { command: "claude", target: "01-mawjs:0.0", pid: 1001 },
        { command: "claude", target: "02-neo:0.0", pid: 1002 },
        { command: "zsh", target: "02-neo:1.0", pid: 1003 },
      ];
    },
  },
  buildAgentRows: buildRows,
}));

const plugin = await import("../../src/vendor/mpr-plugins/serve-agents/index.ts?plugin-serve-agents-standalone");

async function json(response: Response): Promise<any> {
  return await response.json();
}

describe("serve-agents plugin standalone boundary (#2447)", () => {
  test("imports agent listing dependencies only through the SDK and serve types", () => {
    expectStandalonePluginBoundary({ plugin: "serve-agents" });
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/serve-agents/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "maw-js/plugin/types"');
  });

  test("serve hook registers the legacy /api/agents routes", async () => {
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

    plugin.serve({
      http: {
        route(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
        },
      },
    });

    expect([...routes.keys()].sort()).toEqual([
      "GET /api/agent",
      "GET /api/agents",
    ]);

    const res = await routes.get("GET /api/agents")!(new Request("http://local/api/agents"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ count: 2, node: "test-node" });
    expect(body.agents.map((agent: any) => agent.oracle).sort()).toEqual(["mawjs", "neo"]);
    expect(body.agents.every((agent: any) => agent.window.endsWith("-oracle"))).toBe(true);

    const alias = await routes.get("GET /api/agent")!(new Request("http://local/api/agent"));
    expect(await json(alias)).toEqual(body);
  });

  test("preserves all-pane query handling and row shape", async () => {
    listAllError = undefined;
    listPanesError = undefined;
    const res = await plugin.buildAgentsReadResponse(new Request("http://local/api/agents?all=true"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.count).toBe(3);
    expect(body.agents.find((agent: any) => agent.window === "shell")).toBeDefined();
    expect(body.agents[0]).toEqual(expect.objectContaining({
      node: expect.any(String),
      session: expect.any(String),
      window: expect.any(String),
      oracle: expect.any(String),
      state: expect.any(String),
      pid: expect.any(Number),
    }));

    const one = await plugin.buildAgentsReadResponse(new Request("http://local/api/agents?all=1"));
    expect((await json(one)).count).toBe(3);
  });

  test("reports tmux failures as route errors without throwing", async () => {
    listAllError = new Error("tmux offline");
    try {
      const res = await plugin.buildAgentsReadResponse(new Request("http://local/api/agents"));
      expect(res.status).toBe(500);
      expect(await json(res)).toEqual({ error: "tmux offline" });
    } finally {
      listAllError = undefined;
      listPanesError = undefined;
    }
  });

  test("serve hook fails clearly without route registration context", () => {
    expect(() => plugin.serve({})).toThrow("serve-agents requires serve http route registration");
  });
});
