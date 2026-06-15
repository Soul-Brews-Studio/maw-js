import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/assign");

let hostExecCalls: string[] = [];
let wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
let fetchedIssues: Array<{ num: number; repo?: string }> = [];

const sdkMock = {
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "neo-oracle\n";
  },
  fetchIssuePrompt: async (num: number, repo?: string) => {
    fetchedIssues.push({ num, repo });
    return `issue ${num} prompt for ${repo}`;
  },
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    return "woke";
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

function loadAssignPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

beforeEach(() => {
  hostExecCalls = [];
  wakeCalls = [];
  fetchedIssues = [];
  delete process.env.TMUX;
});

describe("assign plugin standalone boundary (#2251)", () => {
  test("imports runtime dependencies only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "assign" });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
  });

  test("plugin loads and missing issue URL returns InvokeResult error", async () => {
    const plugin = loadAssignPlugin();

    const result = await invokePlugin(plugin, { source: "cli", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw assign <issue-url>");
  });

  test("CLI --oracle fetches issue prompt and wakes requested oracle", async () => {
    const plugin = loadAssignPlugin();
    const out: string[] = [];

    const result = await invokePlugin(plugin, {
      source: "cli",
      args: ["https://github.com/Soul-Brews-Studio/maw-js/issues/2251", "--oracle", "neo"],
      writer: (...args: unknown[]) => out.push(args.map(String).join(" ")),
    });

    expect(result.ok).toBe(true);
    expect(fetchedIssues).toEqual([{ num: 2251, repo: "Soul-Brews-Studio/maw-js" }]);
    expect(wakeCalls).toEqual([
      {
        oracle: "neo",
        opts: {
          incubate: "Soul-Brews-Studio/maw-js",
          task: "issue-2251",
          prompt: "issue 2251 prompt for Soul-Brews-Studio/maw-js",
        },
      },
    ]);
    expect(hostExecCalls).toEqual([]);
    expect(out.join("\n")).toContain("fetching issue #2251");
  });

  test("CLI can detect oracle from tmux window through SDK hostExec", async () => {
    process.env.TMUX = "/tmp/tmux.sock";
    const plugin = loadAssignPlugin();

    const result = await invokePlugin(plugin, {
      source: "cli",
      args: ["https://github.com/Soul-Brews-Studio/maw-js/issues/2251"],
    });

    expect(result.ok).toBe(true);
    expect(hostExecCalls).toEqual(["tmux display-message -p '#{window_name}'"]);
    expect(wakeCalls[0]?.oracle).toBe("neo");
  });
});
