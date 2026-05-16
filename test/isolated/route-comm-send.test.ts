/**
 * route-comm-send.test.ts — #1388 regression guard.
 *
 * Top-level `maw send` is message delivery, not raw pane typing. It must
 * route through the same core cmdSend path as `maw hey`, which appends Enter
 * through the transport and reports `delivered` instead of leaving text in the
 * target prompt buffer.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

const calls: unknown[][] = [];
const peekCalls: unknown[][] = [];
const logs: string[] = [];

mock.module("../../src/commands/shared/comm", () => ({
  cmdSend: async (...args: unknown[]) => { calls.push(args); },
  cmdPeek: async (...args: unknown[]) => { peekCalls.push(args); },
}));

const origLog = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

const { routeComm } = await import("../../src/cli/route-comm");

afterAll(() => { console.log = origLog; });

beforeEach(() => {
  calls.length = 0;
  peekCalls.length = 0;
  logs.length = 0;
});

describe("routeComm — top-level send uses core delivery (#1388)", () => {
  test("maw send <target> <message> routes through cmdSend like maw hey", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "world"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello world", false, { approve: false, trust: false }],
    ]);
  });

  test("--force is preserved and stripped from the delivered message", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "--force"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", true, { approve: false, trust: false }],
    ]);
  });

  test("maw hey remains on the same core path", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "ping"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "ping", false, { approve: false, trust: false }],
    ]);
  });

  test("maw send --help prints usage instead of treating --help as a target (#1531)", async () => {
    const handled = await routeComm("send", ["send", "--help"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("usage: maw send <target> <message>");
    expect(logs.join("\n")).toContain("local:<agent>");
  });

  test("maw hey -h prints usage instead of treating -h as a target (#1531)", async () => {
    const handled = await routeComm("hey", ["hey", "-h"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("usage: maw hey <target> <message>");
  });

  test("maw peek routes through federation-aware cmdPeek, not tmux alias", async () => {
    const handled = await routeComm("peek", ["peek", "m5:mawjs"]);

    expect(handled).toBe(true);
    expect(peekCalls).toEqual([["m5:mawjs"]]);
    expect(calls).toEqual([]);
  });
});
