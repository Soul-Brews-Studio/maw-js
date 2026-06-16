import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

type SessionLike = {
  name: string;
  windows?: Array<{ index?: number; name?: string }>;
};

let sessions: SessionLike[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => string | Promise<string> = () => "";

const sdkMock = {
  listSessions: async () => sessions,
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return await hostExecImpl(cmd);
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(new URL("../../src/sdk/index.ts", import.meta.url).pathname, () => ({ ...realSdk, ...sdkMock }));

const { command, default: killHandler } = await import("../../src/vendor/mpr-plugins/kill/index.ts?plugin-kill-standalone");
const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl.ts?plugin-kill-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  sessions = [];
  hostExecCalls = [];
  hostExecImpl = () => "";
});

describe("kill plugin standalone boundary", () => {
  test("uses the SDK/plugin boundary with an explicit shared pane resolver exception", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "kill",
      allowMawJs: [/^maw-js\/core\/matcher\/resolve-target$/],
      allowRelative: [/commands\/shared\/pane-target-resolver$/, /core\/xdg$/],
    });

    expect(command).toMatchObject({ name: "kill" });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
    expect(imports.map((record) => record.spec)).toContain("maw-js/cli/parse-args");
  });

  test("handler parses --index and --all for local CLI and peer forwarding", async () => {
    sessions = [{ name: "47-mawjs", windows: [{ index: 0, name: "lead" }, { index: 5, name: "codex" }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("kill-window -t '47-mawjs:5'")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const indexed = await killHandler({ source: "cli", args: ["47-mawjs:codex", "--index", "5"] } as any);
    expect(indexed.ok).toBe(true);
    expect(stripAnsi(indexed.output)).toContain("killed window 47-mawjs:5");
    expect(hostExecCalls).toEqual(["tmux kill-window -t '47-mawjs:5'"]);

    hostExecCalls = [];
    sessions = [{ name: "47-mawjs", windows: [{ index: 2, name: "codex" }, { index: 5, name: "codex" }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("kill-window -t '47-mawjs:2'")) return "";
      if (cmd.includes("kill-window -t '47-mawjs:5'")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const all = await killHandler({ source: "cli", args: ["47-mawjs:codex", "--all"] } as any);
    expect(all.ok).toBe(true);
    expect(stripAnsi(all.output)).toContain("killed 2 windows 47-mawjs:2, 47-mawjs:5");
    expect(hostExecCalls).toEqual(["tmux kill-window -t '47-mawjs:2'", "tmux kill-window -t '47-mawjs:5'"]);
  });

  test("cmdKill refuses duplicate window names with actionable diagnostics", async () => {
    sessions = [{
      name: "47-mawjs",
      windows: [
        { index: 0, name: "lead" },
        { index: 2, name: "codex" },
        { index: 5, name: "codex" },
      ],
    }];

    await expect(cmdKill("47-mawjs:codex")).rejects.toThrow("window 'codex' is ambiguous in session 47-mawjs");
    expect(hostExecCalls).toEqual([]);
  });
});
