/** Targeted isolated coverage for src/vendor/mpr-plugins/whoami/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let hostExecCalls: string[] = [];
let hostExecResult = "oracle-session\n";
let logs: string[] = [];

const originalTmux = process.env.TMUX;
const originalLog = console.log;

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return hostExecResult;
  },
}));

const { cmdWhoami } = await import("../../src/vendor/mpr-plugins/whoami/impl.ts?whoami-impl-coverage");

beforeEach(() => {
  hostExecCalls = [];
  hostExecResult = "oracle-session\n";
  logs = [];
  process.env.TMUX = "/tmp/tmux-1000/default,1,0";
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  console.log = originalLog;
});

describe("whoami impl isolated coverage", () => {
  test("requires tmux before shelling out", async () => {
    delete process.env.TMUX;

    await expect(cmdWhoami()).rejects.toThrow("maw whoami requires an active tmux session");
    expect(hostExecCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("--short mode prints just the trimmed tmux session name (legacy contract)", async () => {
    hostExecResult = "  live-oracle  \n";

    await cmdWhoami(["--short"]);

    expect(hostExecCalls).toEqual([`tmux display-message -p '#S'`]);
    expect(logs).toEqual(["live-oracle"]);
  });

  test("default mode prints session + window + pane address (#1916 LOW-2)", async () => {
    hostExecResult = "live-oracle\tmain\t@7\tClaude Code\t%42\n";

    await cmdWhoami();

    expect(hostExecCalls).toEqual([
      `tmux display-message -p '#S\t#W\t#{window_id}\t#{pane_title}\t#{pane_id}'`,
    ]);
    expect(logs.join("\n")).toContain("session  live-oracle");
    expect(logs.join("\n")).toContain("window   main");
    expect(logs.join("\n")).toContain("@7");
    expect(logs.join("\n")).toContain("pane     Claude Code");
    expect(logs.join("\n")).toContain("%42");
    expect(logs.join("\n")).toContain("target");
    expect(logs.join("\n")).toContain("live-oracle:main");
  });

  test("--json mode prints a single machine-readable line", async () => {
    hostExecResult = "live-oracle\tmain\t@7\tClaude Code\t%42\n";

    await cmdWhoami(["--json"]);

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0]!);
    expect(payload).toEqual({
      session: "live-oracle",
      window: "main",
      window_id: "@7",
      pane_title: "Claude Code",
      pane_id: "%42",
      target: "live-oracle:main.42",
    });
  });
});
