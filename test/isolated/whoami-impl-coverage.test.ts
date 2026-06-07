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

  test("prints the trimmed current tmux session name", async () => {
    hostExecResult = "  live-oracle  \n";

    await cmdWhoami();

    expect(hostExecCalls).toEqual([`tmux display-message -p '#S'`]);
    expect(logs).toEqual(["live-oracle"]);
  });
});
