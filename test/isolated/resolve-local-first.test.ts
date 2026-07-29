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
import { join } from "path";

// ─── Mutable stubs — each test sets these ────────────────────────────────────

let fakeSessions: Array<{ name: string; windows: Array<{ index: number; name: string; active: boolean }> }> = [];
let fakeCurlResponse: { ok: boolean; status: number; data: unknown } = { ok: false, status: 0, data: null };
let sendKeysCalled = false;
let curlFetchCalled = false;
let curlFetchUrl = "";
const _rSdk = await import("../../src/sdk");
const { resolveTarget } = await import("../../src/core/routing");
const origClaudeAgentName = process.env.CLAUDE_AGENT_NAME;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;

// ─── Module mocks (must be before any imports of the modules under test) ─────

import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

mock.module(join(import.meta.dir, "../../src/config"), () => mockConfigModule(() => ({
  node: "white",
  port: 3456,
  commands: { default: "claude" },
  namedPeers: [{ name: "mba", url: "http://mba.wg:3457" }],
  agents: { homekeeper: "mba" },
  sessions: {},
})));

mock.module(join(import.meta.dir, "../../src/core/transport/ssh"), () => mockSshModule({
  listSessions: async () => fakeSessions,
  sendKeys: async () => { sendKeysCalled = true; },
  capture: async () => "",
  getPaneCommand: async () => "claude",
  getPaneCommands: async () => [],
  getPaneInfos: async () => ({}),
  hostExec: async () => { throw new Error("tmux unavailable in test"); },
}));

mock.module(join(import.meta.dir, "../../src/core/transport/curl-fetch"), () => ({
  curlFetch: async (url: string) => {
    curlFetchCalled = true;
    curlFetchUrl = url;
    return fakeCurlResponse;
  },
}));

mock.module(join(import.meta.dir, "../../src/core/transport/peers"), () => ({
  findPeerForTarget: async () => null,
  getPeers: () => [],
  getFederationStatus: async () => ({ peers: [], totalPeers: 0, reachablePeers: 0 }),
}));

mock.module(join(import.meta.dir, "../../src/core/runtime/hooks"), () => ({ runHook: async () => {} }));

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._rSdk,
  listSessions: async () => fakeSessions,
  capture: async () => "",
  sendKeys: async () => { sendKeysCalled = true; },
  getPaneCommand: async () => "claude",
  isAgentCommand: (cmd: string | null | undefined) => /claude|codex|node/i.test(cmd ?? ""),
  findPeerForTarget: async () => null,
  resolveTarget,
  curlFetch: async (url: string) => {
    curlFetchCalled = true;
    curlFetchUrl = url;
    return fakeCurlResponse;
  },
  runHook: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/worktrees"), () => ({
  scanWorktrees: async () => [],
  cleanupWorktree: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake"), () => ({
  resolveFleetSession: () => null,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/comm-log-feed"), () => ({
  logMessage: () => {},
  emitFeed: () => {},
}));

// tmux module — stub so sdk can import without a real tmux socket
// kobo-596: `.run()` must actually exist and return SOMETHING resolveOraclePane
// can parse — an empty class here (its prior shape) makes `new Tmux().run(...)`
// throw "not a function" on every call, silently swallowed by the old
// try/catch-and-fall-back-to-raw-target code. That's a real, previously
// invisible mock gap: this test's "(1) local hit" case exercises the exact
// tmux pane-resolution path, and this stub never actually let it succeed —
// kobo-596's new degraded-diagnostics surfaced it (this file's own tests were
// silently degraded the whole time, not just the "no network" case they name).
// `tmuxListPanesShouldThrow` lets ONE test (below) simulate the real
// resolveOraclePane failure kobo-596's reviewer said they'd trigger and check
// live output for — everything else keeps the working default.
let tmuxListPanesShouldThrow = false;
mock.module(join(import.meta.dir, "../../src/core/transport/tmux"), () => ({
  tmux: {},
  Tmux: class {
    async run() {
      if (tmuxListPanesShouldThrow) throw new Error("tmux server not running");
      return "0 claude\n"; // single-pane window → resolveOraclePane returns the target unchanged, no error
    }
    async tryRun() { return "0 claude\n"; }
  },
  tmuxCmd: () => "tmux",
  resolveSocket: () => null,
  withPaneLock: async (_target: string, fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "",
  tagPane: async () => {},
  readPaneTags: async () => ({}),
}));

// Suppress plugin registry (not used in these tests)
mock.module(join(import.meta.dir, "../../src/plugin/registry"), () => ({
  discoverPackages: () => [],
  invokePlugin: async () => ({ ok: false }),
}));

const { cmdSend } = await import("../../src/commands/shared/comm-send");

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
    tmuxListPanesShouldThrow = false; // kobo-596: default to the working mock; one test opts in
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
    process.env.CLAUDE_AGENT_NAME = "test-sender";
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    delete process.env.MAW_QUIET;
    if (origClaudeAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
    else process.env.CLAUDE_AGENT_NAME = origClaudeAgentName;
    if (origSshClient === undefined) delete process.env.SSH_CLIENT;
    else process.env.SSH_CLIENT = origSshClient;
    if (origSshConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = origSshConnection;
    if (origSshTty === undefined) delete process.env.SSH_TTY;
    else process.env.SSH_TTY = origSshTty;
  });

  // ── Case 1: local hit ──────────────────────────────────────────────────────

  test("(1) local hit — routes via tmux, no network", async () => {
    fakeSessions = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];

    await cmdSend("white:mawjs", "hello local");

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalled).toBe(true);
    expect(curlFetchCalled).toBe(false);
    expect(consoleOut.some(l => l.includes("landed"))).toBe(true); // kobo-596: local-send wording, "delivered" → "landed"
  });

  // kobo-596 (option C) — the live-triggered case reviewer said they'd check:
  // resolveOraclePane's own tmux call actually throws (not a synthetic
  // diagnostics object built by hand), through the REAL cmdSend path. The
  // receipt must say DEGRADED, not silently print "landed"/"delivered" as if
  // resolution had gone cleanly — that silent fallback is the exact defect
  // this card exists to close.
  test("kobo-596: resolveOraclePane's tmux call really throws → receipt reads degraded, not landed/delivered", async () => {
    fakeSessions = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];
    tmuxListPanesShouldThrow = true;

    await cmdSend("white:mawjs", "hello local");

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalled).toBe(true); // the send itself still goes through — degraded, not blocked
    const line = consoleOut.find(l => l.includes("degraded"));
    expect(line).toBeDefined();
    expect(line).toContain("tmux server not running"); // the real error, not swallowed
    expect(consoleOut.some(l => l.includes("landed"))).toBe(false); // must NOT ALSO claim the clean-path wording
    expect(consoleOut.some(l => l.includes("delivered"))).toBe(false); // must NOT silently fall back to the old lie either
  });

  // ── Case 2: local miss + remote hit ───────────────────────────────────────

  test("(2) local miss + remote hit — routes to peer, delivered", async () => {
    fakeSessions = [];
    fakeCurlResponse = {
      ok: true,
      status: 200,
      data: { ok: true, target: "homekeeper", lastLine: "", state: "delivered" },
    };

    await cmdSend("mba:homekeeper", "hello remote");

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
      cmdSend("mba:homekeeper", "hello unreachable"),
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
