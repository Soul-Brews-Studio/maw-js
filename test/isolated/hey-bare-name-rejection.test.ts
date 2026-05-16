/**
 * hey-bare-name-rejection.test.ts — #1572.
 *
 * Verifies that `maw hey <bare-name> "..."` is local-first: cmdSend accepts a
 * bare name only when the shared resolver finds a local tmux target. Misses do
 * not fall through to peer routing; cross-node delivery still needs `<node>:`.
 *
 * Mocked seams: src/sdk, src/config, src/core/routing,
 *   src/core/runtime/hooks, src/commands/shared/comm-log-feed,
 *   src/commands/shared/wake-resolve, src/commands/shared/wake-cmd.
 *
 * process.exit is stubbed to throw "__exit__:<code>" so the harness survives
 * branches that would otherwise terminate the runner.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

// ─── Gate ────────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ────────────────

const _rSdk = await import("../../src/sdk");

// ─── Mutable stubs ───────────────────────────────────────────────────────────

let sendKeysCalls: Array<{ target: string; text: string }> = [];
let resolveTargetCalls = 0;
let listSessionsCalls = 0;
let cmdWakeCalls = 0;
let resolveTargetReturn: unknown = { type: "error", reason: "not_found", detail: "…" };
let listSessionsReturn: Array<{ name: string; windows: Array<{ index: number; name: string; active: boolean }> }> = [];

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._rSdk,
  capture: async () => "",
  sendKeys: async (target: string, text: string) => {
    if (!mockActive) return;
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => "claude",
  listSessions: async () => {
    if (!mockActive) return [];
    listSessionsCalls++;
    return listSessionsReturn;
  },
  findPeerForTarget: async () => null,
  resolveTarget: () => {
    resolveTargetCalls++;
    return resolveTargetReturn;
  },
  curlFetch: async () => ({ ok: false, status: 500, data: {} }),
  runHook: async () => {},
  hostExec: async () => "",
}));

mock.module(join(import.meta.dir, "../../src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({ node: "test-node", port: 3456 }));
});

mock.module(join(import.meta.dir, "../../src/core/runtime/hooks"), () => ({
  runHook: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/comm-log-feed"), () => ({
  logMessage: () => {},
  emitFeed: () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-resolve"), () => ({
  resolveFleetSession: () => null,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async () => {
    cmdWakeCalls++;
    return null;
  },
}));

// Bun.sleep intercept — keep tests fast
const origSleep = Bun.sleep.bind(Bun);
(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

// ─── Imports (after mocks) ────────────────────────────────────────────────────

const { cmdSend } = await import("../../src/commands/shared/comm-send");

// ─── Harness ─────────────────────────────────────────────────────────────────

const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;

let exitCode: number | undefined;
let errs: string[] = [];
let logs: string[] = [];

async function run(fn: () => Promise<unknown>): Promise<void> {
  exitCode = undefined; errs = []; logs = [];
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  sendKeysCalls = [];
  resolveTargetCalls = 0;
  listSessionsCalls = 0;
  cmdWakeCalls = 0;
  resolveTargetReturn = { type: "error", reason: "not_found", detail: "…" };
  listSessionsReturn = [];
  delete process.env.MAW_QUIET;
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdSend — bare-name local-first (#1572)", () => {
  test("bare name 'mawjs-oracle' → local resolver hit sends to same-node target", async () => {
    listSessionsReturn = [
      { name: "47-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    resolveTargetReturn = { type: "local", target: "47-mawjs:0" };

    await run(() => cmdSend("mawjs-oracle", "test"));

    expect(exitCode).toBeUndefined();
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
    expect(listSessionsCalls).toBeGreaterThanOrEqual(1);
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0].target).toBe("47-mawjs:0");
  });

  test("bare name 'mawjs-oracle' with no local hit → exits 1, prints local-only error, no send", async () => {
    resolveTargetReturn = { type: "peer", peerUrl: "http://remote", target: "mawjs-oracle", node: "mba" };
    await run(() => cmdSend("mawjs-oracle", "test"));

    expect(exitCode).toBe(1);
    const allErr = errs.join("\n");
    expect(allErr).toContain("error");
    expect(allErr).toContain("not found locally");
    expect(allErr).toContain("bare names are local-only");
    expect(allErr).toContain("same-node targets:");
    expect(allErr).toContain("maw hey local:mawjs-oracle");
    expect(allErr).toContain("cross-node targets:");
    expect(allErr).toContain("maw hey <node>:mawjs-oracle");
    expect(allErr).toContain("maw locate mawjs-oracle");
    // Local resolution happened, but remote/fallback delivery did not.
    expect(resolveTargetCalls).toBe(1);
    expect(listSessionsCalls).toBe(1);
    expect(cmdWakeCalls).toBe(0);
    expect(sendKeysCalls.length).toBe(0);
  });

  test("MAW_QUIET=1 does NOT bypass the local-only miss", async () => {
    process.env.MAW_QUIET = "1";
    await run(() => cmdSend("mawjs-oracle", "test"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("not found locally");
    expect(sendKeysCalls.length).toBe(0);
  });

  test("node-prefixed target 'test-node:foo' passes — no rejection", async () => {
    await run(() => cmdSend("test-node:foo", "hi"));
    // Either resolved as local/self-node and sent, or hit a downstream branch —
    // the key invariant is we did NOT exit on the bare-name local-only guard.
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("not found locally");
    // Resolution was attempted
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });

  test("team:<name> prefix passes the bare-name guard", async () => {
    // team: routing has its own validation downstream; we only assert the
    // bare-name local-only guard didn't fire.
    await run(() => cmdSend("team:nonexistent-team", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("not found locally");
  });

  test("plugin:<name> prefix passes the bare-name guard", async () => {
    await run(() => cmdSend("plugin:nonexistent-plugin", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("not found locally");
  });

  test("path-style target with '/' passes the bare-name guard", async () => {
    await run(() => cmdSend("some/path", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("not found locally");
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });
});
