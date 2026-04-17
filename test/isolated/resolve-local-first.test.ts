/**
 * Isolated tests for local-first routing in cmdSend (#411).
 *
 * Three cases:
 *   1. local hit  — target in tmux sessions → sendKeys, no network
 *   2. local miss + remote hit — agents config peer is reachable → delivered
 *   3. local miss + remote peer unreachable — error says "Remote fetch failed"
 *      NOT "not found in local sessions"
 *
 * Uses real resolveTarget so routing logic is validated end-to-end.
 * Network is mocked via curlFetch stub.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ─── Mutable stubs — each test sets these ────────────────────────────────────

let fakeSessions: Array<{ name: string; windows: Array<{ index: number; name: string; active: boolean }> }> = [];
let fakeCurlResponse: { ok: boolean; status: number; data: unknown } = { ok: false, status: 0, data: null };
let fakePeerForTarget: string | null = null;
let sendKeysCalled = false;
let curlFetchCalled = false;
let curlFetchUrl = "";

// ─── Module mocks (must be before any imports of the modules under test) ─────

import { mockConfigModule } from "../helpers/mock-config";

mock.module("../../src/config", () => mockConfigModule(() => ({
  node: "white",
  port: 3456,
  namedPeers: [{ name: "mba", url: "http://mba.wg:3457" }],
  agents: { homekeeper: "mba" },
  sessions: {},
})));

mock.module("../../src/core/transport/ssh", () => ({
  listSessions: async () => fakeSessions,
  sendKeys: async () => { sendKeysCalled = true; },
  capture: async () => "",
  getPaneCommand: async () => "claude",
  getPaneCommands: async () => [],
  getPaneInfos: async () => ({}),
  hostExec: async () => { throw new Error("tmux unavailable in test"); },
  HostExecError: class HostExecError extends Error {},
}));

mock.module("../../src/core/transport/curl-fetch", () => ({
  curlFetch: async (url: string) => {
    curlFetchCalled = true;
    curlFetchUrl = url;
    return fakeCurlResponse;
  },
}));

mock.module("../../src/core/transport/peers", () => ({
  findPeerForTarget: async () => fakePeerForTarget,
  getPeers: () => [],
  getFederationStatus: async () => ({ peers: [], totalPeers: 0, reachablePeers: 0 }),
}));

mock.module("../../src/core/runtime/hooks", () => ({ runHook: async () => {} }));

mock.module("../../src/core/fleet/worktrees", () => ({
  scanWorktrees: async () => [],
  cleanupWorktree: async () => {},
}));

mock.module("../../src/commands/shared/wake", () => ({
  resolveFleetSession: () => null,
}));

mock.module("../../src/commands/shared/comm-log-feed", () => ({
  logMessage: () => {},
  emitFeed: () => {},
}));

// tmux module — stub so sdk can import without a real tmux socket
mock.module("../../src/core/transport/tmux", () => ({
  tmux: {},
  Tmux: class {},
  tmuxCmd: () => "tmux",
  resolveSocket: () => null,
  withPaneLock: async (_target: string, fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "",
  tagPane: async () => {},
  readPaneTags: async () => ({}),
}));

// Suppress plugin registry (not used in these tests)
mock.module("../../src/plugin/registry", () => ({
  discoverPackages: () => [],
  invokePlugin: async () => ({ ok: false }),
}));

import { cmdSend } from "../../src/commands/shared/comm";

// ─── Test harness ─────────────────────────────────────────────────────────────

describe("local-first routing (#411)", () => {
  let exitCode: number | undefined;
  let consoleOut: string[] = [];
  let consoleErr: string[] = [];
  let originalExit: typeof process.exit;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    exitCode = undefined;
    consoleOut = [];
    consoleErr = [];
    sendKeysCalled = false;
    curlFetchCalled = false;
    curlFetchUrl = "";
    fakeSessions = [];
    fakeCurlResponse = { ok: false, status: 0, data: null };
    fakePeerForTarget = null;

    originalExit = process.exit;
    originalLog = console.log;
    originalError = console.error;

    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    console.log = (...args: unknown[]) => { consoleOut.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { consoleErr.push(args.map(String).join(" ")); };

    process.env.MAW_QUIET = "1";
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    delete process.env.MAW_QUIET;
  });

  // ── Case 1: local hit ──────────────────────────────────────────────────────

  test("(1) local hit — routes via tmux, no network", async () => {
    fakeSessions = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];

    await cmdSend("mawjs", "hello local");

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalled).toBe(true);
    expect(curlFetchCalled).toBe(false);
    expect(consoleOut.some(l => l.includes("delivered"))).toBe(true);
  });

  // ── Case 2: local miss + remote hit ───────────────────────────────────────

  test("(2) local miss + remote hit — routes to peer, delivered", async () => {
    fakeSessions = [];
    fakeCurlResponse = {
      ok: true,
      status: 200,
      data: { ok: true, target: "homekeeper", lastLine: "" },
    };

    await cmdSend("homekeeper", "hello remote");

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalled).toBe(false);
    expect(curlFetchCalled).toBe(true);
    expect(curlFetchUrl).toContain("mba.wg:3457");
    expect(consoleOut.some(l => l.includes("delivered"))).toBe(true);
  });

  // ── Case 3: local miss + remote peer unreachable ───────────────────────────

  test("(3) local miss + remote peer unreachable — surfaces remote failure, not local-miss", async () => {
    fakeSessions = [];
    // curlFetch returns failure (peer unreachable)
    fakeCurlResponse = { ok: false, status: 0, data: null };

    await expect(
      cmdSend("homekeeper", "hello unreachable"),
    ).rejects.toThrow("process.exit");

    expect(exitCode).toBe(1);
    expect(curlFetchCalled).toBe(true);

    const errOutput = consoleErr.join("\n");

    // Must surface the remote failure explicitly — not a local-miss message
    expect(errOutput).toContain("Remote fetch failed for peer");
    expect(errOutput).toContain("mba.wg:3457");

    // Must NOT say "not in local sessions" when the real failure was network (#411)
    expect(errOutput).not.toContain("not in local sessions or agents map");
  });
});
