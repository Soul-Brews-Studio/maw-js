import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type MockWindow = { index: number; name: string; active?: boolean };
type MockSession = { name: string; windows: MockWindow[] };

let sessions: MockSession[] = [];
const tmuxCalls: Array<{ method: string; args: unknown[] }> = [];
let configPort = 7331;

const tmux = {
  killSession: async (...args: unknown[]) => tmuxCalls.push({ method: "killSession", args }),
  newSession: async (...args: unknown[]) => tmuxCalls.push({ method: "newSession", args }),
  set: async (...args: unknown[]) => tmuxCalls.push({ method: "set", args }),
  newWindow: async (...args: unknown[]) => tmuxCalls.push({ method: "newWindow", args }),
  selectPane: async (...args: unknown[]) => tmuxCalls.push({ method: "selectPane", args }),
  sendKeys: async (...args: unknown[]) => tmuxCalls.push({ method: "sendKeys", args }),
  splitWindow: async (...args: unknown[]) => tmuxCalls.push({ method: "splitWindow", args }),
  selectLayout: async (...args: unknown[]) => tmuxCalls.push({ method: "selectLayout", args }),
  selectWindow: async (...args: unknown[]) => tmuxCalls.push({ method: "selectWindow", args }),
};

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  listSessions: async () => sessions,
  hostExec: async () => "",
  tmux,
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ port: configPort }),
}));

const impl = await import("../../src/vendor/mpr-plugins/overview/impl.ts?plugin-overview-standalone");
const { default: overviewHandler } = await import("../../src/vendor/mpr-plugins/overview/index.ts?plugin-overview-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  configPort = 7331;
  tmuxCalls.length = 0;
  sessions = [
    { name: "1-alpha", windows: [{ index: 0, name: "shell" }, { index: 2, name: "agent", active: true }] },
    { name: "2-beta", windows: [{ index: 1, name: "beta", active: true }] },
    { name: "docs", windows: [{ index: 0, name: "docs", active: true }] },
    { name: "0-overview", windows: [{ index: 0, name: "overview", active: true }] },
  ];
});

describe("overview plugin standalone boundary (#2248)", () => {
  test("uses only SDK/config plus plugin-local imports, with no core/shared/lib imports", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/overview/index.ts",
      "src/vendor/mpr-plugins/overview/impl.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }

    const implSource = readFileSync(join(root, "src/vendor/mpr-plugins/overview/impl.ts"), "utf8");
    expect(implSource).toContain('from "maw-js/sdk"');
    expect(implSource).toContain('from "maw-js/config"');
  });

  test("builds filtered active-window targets and helper output", () => {
    const targets = impl.buildTargets(sessions as any, ["alp"]);

    expect(targets).toEqual([
      { session: "1-alpha", window: 2, windowName: "agent", oracle: "alpha" },
    ]);
    expect(impl.paneTitle(targets[0])).toBe("alpha (1-alpha:2)");
    expect(impl.paneColor(10)).toBe("colour204");
    expect(impl.pickLayout(2)).toBe("even-horizontal");
    expect(impl.pickLayout(3)).toBe("tiled");
  });

  test("chunks targets, normalizes mirrors, and builds mirror command from config", () => {
    const targets = Array.from({ length: 10 }, (_, i) => ({
      session: `${i + 1}-agent`,
      window: i,
      windowName: "main",
      oracle: `agent-${i + 1}`,
    }));

    expect(impl.chunkTargets(targets).map((page: unknown[]) => page.length)).toEqual([9, 1]);
    expect(impl.processMirror("\nheader\n────────\nlast\n", 3)).toBe("header\n────────────────────────────────────────────────────────────\nlast");
    expect(impl.mirrorCmd({ session: "1-alpha", window: 2, windowName: "agent", oracle: "alpha" })).toBe(
      "watch --color -t -n0.5 'curl -s \"http://localhost:7331/api/mirror?target=1-alpha%3A2&lines=$(tput lines)\"'",
    );
  });

  test("handler kills overview without listing sessions when --kill is passed", async () => {
    const result = await overviewHandler({ source: "cli", args: ["--kill"] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("overview killed");
    expect(tmuxCalls).toEqual([{ method: "killSession", args: ["0-overview"] }]);
  });

  test("handler creates overview pages and mirrors filtered oracle sessions", async () => {
    const result = await overviewHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("overview: 2 oracles across 1 page");
    expect(output).toContain("page-1: alpha, beta");
    expect(output).toContain("attach: tmux attach -t 0-overview");

    expect(tmuxCalls[0]).toEqual({ method: "killSession", args: ["0-overview"] });
    expect(tmuxCalls).toContainEqual({ method: "newSession", args: ["0-overview", { window: "page-1" }] });
    expect(tmuxCalls).toContainEqual({ method: "splitWindow", args: ["0-overview:page-1"] });
    expect(tmuxCalls).toContainEqual({ method: "selectLayout", args: ["0-overview:page-1", "even-horizontal"] });
    expect(tmuxCalls).toContainEqual({ method: "selectWindow", args: ["0-overview:page-1"] });

    const sendKeys = tmuxCalls.filter((call) => call.method === "sendKeys");
    expect(sendKeys.map((call) => call.args[0])).toEqual(["0-overview:page-1.0", "0-overview:page-1.1"]);
    expect(String(sendKeys[0]!.args[1])).toContain("target=1-alpha%3A2");
    expect(String(sendKeys[1]!.args[1])).toContain("target=2-beta%3A1");
  });

  test("handler reports empty fleet as captured stderr output", async () => {
    sessions = [{ name: "docs", windows: [{ index: 0, name: "docs", active: true }] }];

    const result = await overviewHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("no oracle sessions found");
    expect(tmuxCalls).toEqual([{ method: "killSession", args: ["0-overview"] }]);
  });
});
