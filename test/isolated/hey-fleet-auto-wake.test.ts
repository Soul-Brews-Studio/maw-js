/**
 * hey-fleet-auto-wake.test.ts — #736 Phase 1.2.
 *
 * Verifies cmdSend silently auto-wakes fleet-known targets when no local
 * session exists yet — parity with `maw view` / `maw a` (view/impl.ts:107).
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
let listSessionsReturn: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let resolveTargetReturn: { type: string; target: string; node?: string } = { type: "local", target: "test-session:oracle.0" };
let fleetKnown: Set<string> = new Set();
let cmdWakeCalls: Array<{ oracle: string; opts: unknown }> = [];
let listSessionsCallCount = 0;
let listSessionsAfterWake: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> | null = null;

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
    listSessionsCallCount++;
    if (listSessionsCallCount > 1 && listSessionsAfterWake) return listSessionsAfterWake;
    return listSessionsReturn;
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
  resolveTarget: () => resolveTargetReturn,
}));

mock.module(join(import.meta.dir, "../../src/core/runtime/hooks"), () => ({
  runHook: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/comm-log-feed"), () => ({
  logMessage: () => {},
  emitFeed: () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-resolve"), () => ({
  resolveFleetSession: (oracle: string) => fleetKnown.has(oracle) ? `${oracle}-session` : null,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (oracle: string, opts: unknown) => {
    cmdWakeCalls.push({ oracle, opts });
    return `${oracle}-session`;
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
  cmdWakeCalls = [];
  listSessionsCallCount = 0;
  listSessionsAfterWake = null;
  fleetKnown = new Set();
  listSessionsReturn = [];
  resolveTargetReturn = { type: "local", target: "test-session:oracle.0" };
  process.env.MAW_QUIET = "1";
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdSend — fleet auto-wake (#736 Phase 1.2)", () => {
  test("auto-wakes when target is fleet-known and no local session exists", async () => {
    fleetKnown.add("volt");
    listSessionsReturn = []; // no session yet
    listSessionsAfterWake = [{ name: "volt-session", windows: [{ index: 0, name: "volt-oracle", active: true }] }];
    resolveTargetReturn = { type: "local", target: "volt-session:volt-oracle.0" };

    await run(() => cmdSend("volt", "hello"));

    expect(cmdWakeCalls.length).toBe(1);
    expect(cmdWakeCalls[0].oracle).toBe("volt");
    // Auto-wake message printed (no y/N prompt path)
    expect(logs.some(l => l.includes("fleet-known") && l.includes("auto-wake"))).toBe(true);
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0].text).toBe("hello");
    expect(exitCode).toBeUndefined();
  });

  test("does NOT wake when target is fleet-known but session already running", async () => {
    fleetKnown.add("mawjs");
    listSessionsReturn = [{ name: "mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] }];
    resolveTargetReturn = { type: "local", target: "mawjs:mawjs-oracle.0" };

    await run(() => cmdSend("mawjs", "hi"));

    expect(cmdWakeCalls.length).toBe(0);
    expect(sendKeysCalls.length).toBe(1);
  });

  test("does NOT wake when target is unknown (not in fleet)", async () => {
    // fleetKnown empty
    listSessionsReturn = [];
    resolveTargetReturn = { type: "error", target: "typo", detail: "not found", hint: "" } as any;

    await run(() => cmdSend("typo", "hi"));

    expect(cmdWakeCalls.length).toBe(0);
    // resolveTarget returned error → cmdSend exits 1 via the error branch
    expect(exitCode).toBe(1);
  });

  test("does NOT wake on cross-node target (peer handles its own wake)", async () => {
    fleetKnown.add("hojo"); // even if our local fleet knew about it
    listSessionsReturn = [];
    resolveTargetReturn = { type: "peer", target: "hojo", node: "phaith", peerUrl: "http://phaith:3456" } as any;

    await run(() => cmdSend("phaith:hojo", "ping"));

    expect(cmdWakeCalls.length).toBe(0);
  });

  test("auto-wakes on self-node prefixed target (test-node:volt)", async () => {
    fleetKnown.add("volt");
    listSessionsReturn = [];
    listSessionsAfterWake = [{ name: "volt-session", windows: [{ index: 0, name: "volt-oracle", active: true }] }];
    resolveTargetReturn = { type: "self-node", target: "volt-session:volt-oracle.0" };

    await run(() => cmdSend("test-node:volt", "yo"));

    expect(cmdWakeCalls.length).toBe(1);
    expect(cmdWakeCalls[0].oracle).toBe("volt");
    expect(sendKeysCalls.length).toBe(1);
  });

  test("does NOT prompt y/N — wake is silent on fleet-known", async () => {
    fleetKnown.add("colab");
    listSessionsReturn = [];
    listSessionsAfterWake = [{ name: "colab-session", windows: [{ index: 0, name: "colab-oracle", active: true }] }];
    resolveTargetReturn = { type: "local", target: "colab-session:colab-oracle.0" };

    await run(() => cmdSend("colab", "msg"));

    // No prompt-style strings should appear in stderr
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("[y/N]");
    expect(allErr).not.toContain("Wake it now?");
    expect(cmdWakeCalls.length).toBe(1);
  });
});
