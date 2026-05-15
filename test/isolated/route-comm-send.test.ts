/**
 * route-comm-send.test.ts — #1388 regression guard.
 *
 * Top-level `maw send` is message delivery, not raw pane typing. It must
 * route through the same core cmdSend path as `maw hey`, which appends Enter
 * through the transport and reports `delivered` instead of leaving text in the
 * target prompt buffer.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

const calls: unknown[][] = [];
const peekCalls: unknown[][] = [];

mock.module("../../src/commands/shared/comm", () => ({
  cmdSend: async (...args: unknown[]) => { calls.push(args); },
  cmdPeek: async (...args: unknown[]) => { peekCalls.push(args); },
}));

const { routeComm } = await import("../../src/cli/route-comm");

beforeEach(() => {
  calls.length = 0;
  peekCalls.length = 0;
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

  test("maw peek routes through federation-aware cmdPeek, not tmux alias", async () => {
    const handled = await routeComm("peek", ["peek", "m5:mawjs"]);

    expect(handled).toBe(true);
    expect(peekCalls).toEqual([["m5:mawjs"]]);
    expect(calls).toEqual([]);
  });
});
