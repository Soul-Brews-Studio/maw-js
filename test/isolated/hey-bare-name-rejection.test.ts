/**
 * hey-bare-name-rejection.test.ts — #759 Phase 2 + #1136.
 *
 * Verifies the bare-name contract:
 *
 *   #759 Phase 2 (#785) — bare-name targets cannot fall through to the
 *   generic "window not found" path. The Phase 2 error shape (with this-node
 *   suggestion + cross-node placeholders + `maw locate` hint) is what the
 *   user sees instead.
 *
 *   #1136 (relaxation) — when the local resolver finds an unambiguous local
 *   match, the bare name resolves and delivery proceeds. Federation safety
 *   is preserved: the bare-name error still fires when local resolution
 *   misses (or is ambiguous).
 *
 * Mocked seams: src/sdk, src/config, src/core/routing,
 *   src/core/runtime/hooks, src/commands/shared/comm-log-feed,
 *   src/commands/shared/wake-resolve, src/commands/shared/wake-cmd.
 *
 * `resolveTargetMock` is per-test mutable: tests that exercise the local
 * happy path swap it to a "local" result; the rest leave it at the default
 * "error" shape so the bare-name error fires at the end of cmdSend.
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
// Per-test mutable: bare-name tests need this to default to a miss so the
// federation-friendly error fires at the end of cmdSend. Local-fallback tests
// (#1136) flip it to a "local" result before invoking cmdSend.
let resolveTargetMock: any = { type: "error", detail: "no local session found", hint: undefined };

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
    return resolveTargetMock;
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
  resolveTargetMock = { type: "error", detail: "no local session found", hint: undefined };
  delete process.env.MAW_QUIET;
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdSend — bare-name contract (#759 Phase 2 + #1136)", () => {
  test("bare name with no local match → exits 1, prints federation-friendly error", async () => {
    // resolveTargetMock defaults to error (no local match)
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
    // Delivery did NOT happen
    expect(sendKeysCalls.length).toBe(0);
  });

  test("bare name with local match → resolves and delivers, no federation error (#1136)", async () => {
    resolveTargetMock = { type: "local", target: "x:y.0" };
    await run(() => cmdSend("discord-oracle", "hello"));

    const allErr = errs.join("\n");
    // No federation error — local match resolved
    expect(allErr).not.toContain("bare-name target removed");
    expect(allErr).not.toContain("node prefix required");
    // Delivery happened — sendKeys was called once
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0]?.text).toBe("hello");
    // Resolution was attempted
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });

  test("MAW_QUIET=1 does NOT bypass federation error when local match misses", async () => {
    process.env.MAW_QUIET = "1";
    await run(() => cmdSend("mawjs-oracle", "test"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("bare-name target removed");
    expect(sendKeysCalls.length).toBe(0);
  });

  test("node-prefixed target 'test-node:foo' bypasses bare-name probe", async () => {
    resolveTargetMock = { type: "local", target: "test-node:foo.0" };
    await run(() => cmdSend("test-node:foo", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });

  test("team:<name> prefix bypasses bare-name probe", async () => {
    // team: routing has its own validation downstream; we only assert the
    // bare-name path didn't fire.
    await run(() => cmdSend("team:nonexistent-team", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
  });

  test("plugin:<name> prefix bypasses bare-name probe", async () => {
    await run(() => cmdSend("plugin:nonexistent-plugin", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
  });

  test("path-style target with '/' bypasses bare-name probe", async () => {
    resolveTargetMock = { type: "local", target: "some/path.0" };
    await run(() => cmdSend("some/path", "hi"));
    const allErr = errs.join("\n");
    expect(allErr).not.toContain("bare-name target removed");
    expect(resolveTargetCalls).toBeGreaterThanOrEqual(1);
  });
});
