/**
 * hey-bare-name-rejection.test.ts — #759 Phase 2.
 *
 * Verifies that `maw hey <bare-name> "..."` is now a hard error: cmdSend
 * MUST print the Phase 2 error shape on stderr and exit non-zero BEFORE
 * any tmux / sdk / network resolution work happens. No fallthrough, no
 * MAW_QUIET escape hatch.
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
    return [];
  },
  findPeerForTarget: async () => null,
  curlFetch: async () => ({ ok: false, status: 500, data: {} }),
  runHook: async () => {},
  hostExec: async () => "",
}));

mock.module(join(import.meta.dir, "../../src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({ node: "test-node", port: 3456 }));
});

mock.module(join(import.meta.dir, "../../src/core/routing"), () => ({
  resolveTarget: () => {
    resolveTargetCalls++;
    return { type: "local", target: "x:y.0" };
  },
}));

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
  delete process.env.MAW_QUIET;
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdSend — bare-name hard rejection (#759 Phase 2)", () => {
  test("bare name 'mawjs-oracle' → exits 1, prints Phase 2 error, no resolution work", async () => {
    await run(() => cmdSend("mawjs-oracle", "test"));

    expect(exitCode).toBe(1);
    const allErr = errs.join("\n");
    // Error header
    expect(allErr).toContain("error");
    expect(allErr).toContain("bare-name target removed");
    expect(allErr).toContain("node prefix required");
    // this-node form with substituted agent
    expect(allErr).toContain("this node:");
    expect(allErr).toContain("maw hey local:mawjs-oracle");
    // cross-node placeholder form
    expect(allErr).toContain("cross-node candidates:");
    expect(allErr).toContain("maw hey <node>:<session>:mawjs-oracle");
    // locate hint
    expect(allErr).toContain("maw locate mawjs-oracle");
    // No downstream work happened
    expect(resolveTargetCalls).toBe(0);
    expect(listSessionsCalls).toBe(0);
    expect(cmdWakeCalls).toBe(0);
    expect(sendKeysCalls.length).toBe(0);
  });

  test("MAW_QUIET=1 does NOT bypass the rejection — Phase 1 escape hatch is gone", async () => {
    process.env.MAW_QUIET = "1";
    await run(() => cmdSend("mawjs-oracle", "test"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("bare-name target removed");
    expect(sendKeysCalls.length).toBe(0);
  });

  test("node-prefixed target 'test-node:foo' passes — no rejection", async () => {
    await run(() => cmdSend("test-node:foo", "hi"));
    // Either resolved as local/self-node and sent, or hit a downstream branch —
    // the key invariant is we did NOT exit on the bare-name guard.
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
    // Resolution was attempted
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });

  test("team:<name> prefix passes the bare-name guard", async () => {
    // team: routing has its own validation downstream; we only assert the
    // bare-name guard didn't fire.
    await run(() => cmdSend("team:nonexistent-team", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
  });

  test("plugin:<name> prefix passes the bare-name guard", async () => {
    await run(() => cmdSend("plugin:nonexistent-plugin", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
  });

  test("path-style target with '/' passes the bare-name guard", async () => {
    await run(() => cmdSend("some/path", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });
});
