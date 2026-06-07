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
const errors: string[] = [];

mock.module("../../src/commands/shared/comm", () => ({
  cmdSend: async (...args: unknown[]) => { calls.push(args); },
  cmdPeek: async (...args: unknown[]) => { peekCalls.push(args); },
}));

const origLog = console.log;
const origError = console.error;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { routeComm } = await import("../../src/cli/route-comm");

afterAll(() => { console.log = origLog; console.error = origError; });

beforeEach(() => {
  calls.length = 0;
  peekCalls.length = 0;
  logs.length = 0;
  errors.length = 0;
});

describe("routeComm — top-level send uses core delivery (#1388)", () => {
  test("maw send <target> <message> routes through cmdSend like maw hey", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "world"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello world", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  test("--force is preserved as deprecated compatibility and stripped from the delivered message", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "--force"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", true, { approve: false, trust: false, inboxOnly: false }],
    ]);
    expect(errors.join("\n")).toContain("--force is deprecated");
  });

  test("--inbox is stripped from the delivered message and opts out of pane injection", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "hello", "--inbox"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", false, { approve: false, trust: false, inboxOnly: true }],
    ]);
  });

  test("maw hey remains on the same core path", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "ping"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "ping", false, { approve: false, trust: false, inboxOnly: false }],
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

  test("--approve/--trust are stripped from the delivered message and passed as delivery opts", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "hello", "--approve", "--trust"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", false, { approve: true, trust: true, inboxOnly: false }],
    ]);
  });

  test("missing target prints usage to stderr and throws a UserError", async () => {
    await expect(routeComm("send", ["send"])).rejects.toThrow("missing target and message");

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("usage: maw send <target> <message>");
  });

  test("missing message names the target and throws a UserError", async () => {
    await expect(routeComm("hey", ["hey", "local:mawjs"])).rejects.toThrow("missing message for 'local:mawjs'");

    expect(calls).toEqual([]);
    const text = errors.join("\n");
    expect(text).toContain("✗ missing message for target 'local:mawjs'");
    expect(text).toContain("maw hey local:mawjs <message>");
  });

  test("non-comm commands are not handled", async () => {
    await expect(routeComm("wake", ["wake", "mawjs"])).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(peekCalls).toEqual([]);
  });

  test("maw peek routes through federation-aware cmdPeek, not tmux alias", async () => {
    const handled = await routeComm("peek", ["peek", "m5:mawjs"]);

    expect(handled).toBe(true);
    expect(peekCalls).toEqual([["m5:mawjs"]]);
    expect(calls).toEqual([]);
  });
});
