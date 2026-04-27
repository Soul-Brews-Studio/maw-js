/**
 * test/isolated/talk-to-resolve.test.ts
 *
 * #762: `maw talk-to` must inherit the #758 writable filter (drop -view
 * mirrors and federated source records) by routing through resolveTarget
 * instead of calling findWindow directly. Without that, peers with view
 * mirrors or federated copies of the same agent re-trigger the #406
 * AmbiguousMatchError that #758 fixed for `maw hey`.
 *
 * Isolated because we mock.module(".../src/sdk", ".../src/config") —
 * mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// --- Mutable stubs ---
type SessionRow = { name: string; windows: { index: number; name: string; active: boolean }[]; source?: string };

let sessionsToReturn: SessionRow[] = [];
let sendKeysCalls: { target: string; message: string }[] = [];
let runHookCalls: { hook: string; payload: unknown }[] = [];

// Resolve real resolveTarget so the mocked sdk re-exports the real implementation —
// the bug being tested is "talk-to must call this real function," so we must not
// stub it.
const realRouting = await import("../../src/core/routing");

// --- Mock sdk ---
mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => sessionsToReturn,
  sendKeys: async (target: string, message: string) => {
    sendKeysCalls.push({ target, message });
  },
  getPaneCommand: async () => "claude",
  resolveTarget: realRouting.resolveTarget,
  runHook: async (hook: string, payload: unknown) => {
    runHookCalls.push({ hook, payload });
  },
}));

// --- Mock config ---
mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({
    node: "white",
    namedPeers: [{ name: "mba", url: "http://10.20.0.3:3457" }],
    agents: {},
    peers: [],
    oracleUrl: "http://oracle.invalid:1",
  })),
);

// --- Stub fetch so postToThread + getThreadInfo behave deterministically ---
// Returning an unreachable Oracle ⇒ threadResult is null ⇒ talk-to throws on
// "window not found" instead of falling to "thread saved only," which makes
// the error path observable. The success/local-deliver path exercises sendKeys.
const origFetch = globalThis.fetch;

// --- Suppress decorated logs ---
const origLog = console.log;
const origErr = console.error;

// --- Import module-under-test AFTER mocks installed ---
const { cmdTalkTo } = await import("../../src/commands/plugins/talk-to/impl");

beforeEach(() => {
  sessionsToReturn = [];
  sendKeysCalls = [];
  runHookCalls = [];
  // Mock fetch to simulate Oracle reachable + thread created.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/threads?limit=50")) {
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }
    if (url.endsWith("/api/thread")) {
      return new Response(JSON.stringify({ thread_id: 42, message_id: 1, status: "ok" }), { status: 200 });
    }
    if (url.includes("/api/thread/")) {
      return new Response(JSON.stringify({ thread: { id: 42, title: "x", status: "open", created_at: "" }, messages: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  console.error = origErr;
});

afterAll(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  console.error = origErr;
});

describe("cmdTalkTo — #762 routes through resolveTarget", () => {
  test("(a) -view mirror is dropped from talk-to candidates", async () => {
    // Real local writable + read-only mirror with the same window name.
    // Pre-fix this would have thrown AmbiguousMatchError. Post-fix the mirror
    // is filtered out and talk-to delivers to the writable session.
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
      { name: "mawjs-view", windows: [{ index: 1, name: "mawjs-oracle", active: false }] },
    ];

    await cmdTalkTo("mawjs-oracle", "hi");

    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0].target).toBe("08-mawjs:1");
  });

  test("(b) source !== \"local\" is dropped — federated peer record is not a candidate", async () => {
    // Aggregated session list contains a federated record from another peer.
    // resolveTarget's writable filter drops anything tagged with non-local
    // source — this node can't deliver via tmux send-keys to a remote pane.
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }], source: "local" },
      { name: "101-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }], source: "http://oracle-world.wg:3456" },
    ];

    await cmdTalkTo("mawjs-oracle", "hi");

    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0].target).toBe("08-mawjs:1");
  });

  test("(c) genuine local-writable ambiguity still throws (#406 guard intact)", async () => {
    // Two real local sessions both expose the same window name. Filter must
    // NOT collapse this — ambiguity is the correct outcome.
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
      { name: "09-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: false }] },
    ];

    await expect(cmdTalkTo("mawjs-oracle", "hi")).rejects.toThrow(/Ambiguous match/);
    expect(sendKeysCalls).toHaveLength(0);
  });
});
