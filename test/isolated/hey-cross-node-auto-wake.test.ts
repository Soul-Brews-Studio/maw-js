/**
 * hey-cross-node-auto-wake.test.ts — #791 Option B.
 *
 * Verifies cmdSend does cross-node auto-wake by calling the peer's
 * /api/wake before /api/send when the target is short cross-node form
 * (<peer>:<agent>). Sender-side wake+send sequence per the design RFC
 * on issue #791.
 *
 * - Short form (peer:agent) on a peer in namedPeers → wake then send.
 * - Canonical form (peer:session:window) → no wake, just send.
 * - Peer not in namedPeers → no wake call, fall through to resolveTarget.
 * - Wake error → process.exit(1) with wake error message; do NOT proceed to send.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

let mockActive = false;
const _rSdk = await import("../../src/sdk");

let curlFetchCalls: Array<{ url: string }> = [];
let curlFetchHandler: (url: string) => { ok: boolean; status?: number; data: unknown } =
  () => ({ ok: false, status: 500, data: {} });
let listSessionsReturn: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let resolveTargetReturn: unknown = { type: "peer", target: "hojo", node: "phaith", peerUrl: "http://phaith:3456" };
let mockNamedPeers: Array<{ name: string; url: string }> = [];

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._rSdk,
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
  listSessions: async () => mockActive ? listSessionsReturn : [],
  findPeerForTarget: async () => null,
  curlFetch: async (url: string) => {
    if (!mockActive) return { ok: false, status: 0, data: {} };
    curlFetchCalls.push({ url });
    return curlFetchHandler(url);
  },
  runHook: async () => {},
  hostExec: async () => "",
}));

mock.module(join(import.meta.dir, "../../src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({
    node: "test-node",
    port: 3456,
    namedPeers: mockNamedPeers,
  }));
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
  resolveFleetSession: () => null,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async () => "should-not-be-called-for-cross-node",
}));

const origSleep = Bun.sleep.bind(Bun);
(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

const { cmdSend } = await import("../../src/commands/shared/comm-send");

const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
let exitCode: number | undefined;
let errs: string[] = [];

async function run(fn: () => Promise<unknown>): Promise<void> {
  exitCode = undefined; errs = [];
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  console.log = () => {};
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
  curlFetchCalls = [];
  listSessionsReturn = [];
  mockNamedPeers = [];
  curlFetchHandler = () => ({ ok: false, status: 500, data: {} });
  resolveTargetReturn = { type: "peer", target: "hojo", node: "phaith", peerUrl: "http://phaith:3456" };
  process.env.MAW_QUIET = "1";
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

describe("cmdSend — cross-node auto-wake (#791)", () => {
  test("short cross-node form calls /api/wake then /api/send (#791 Option B)", async () => {
    mockNamedPeers = [{ name: "phaith", url: "http://phaith:3456" }];
    curlFetchHandler = (url: string) => {
      if (url.includes("/api/wake")) return { ok: true, status: 200, data: { ok: true, target: "hojo" } };
      if (url.includes("/api/send")) return { ok: true, status: 200, data: { ok: true, target: "hojo:1" } };
      return { ok: false, status: 500, data: {} };
    };

    await run(() => cmdSend("phaith:hojo", "ping"));

    expect(curlFetchCalls.length).toBe(2);
    expect(curlFetchCalls[0].url).toContain("/api/wake");
    expect(curlFetchCalls[1].url).toContain("/api/send");
    expect(exitCode).toBeUndefined();
  });

  test("canonical cross-node form (peer:session:window) does NOT call /api/wake", async () => {
    mockNamedPeers = [{ name: "phaith", url: "http://phaith:3456" }];
    resolveTargetReturn = { type: "peer", target: "01-hojo:3", node: "phaith", peerUrl: "http://phaith:3456" };
    curlFetchHandler = (url: string) => {
      if (url.includes("/api/send")) return { ok: true, status: 200, data: { ok: true, target: "01-hojo:3" } };
      return { ok: false, status: 500, data: {} };
    };

    await run(() => cmdSend("phaith:01-hojo:3", "ping"));

    const wakeCalls = curlFetchCalls.filter(c => c.url.includes("/api/wake"));
    const sendCalls = curlFetchCalls.filter(c => c.url.includes("/api/send"));
    expect(wakeCalls.length).toBe(0);
    expect(sendCalls.length).toBe(1);
  });

  test("peer not in namedPeers → no wake call, fall through to resolveTarget error path", async () => {
    mockNamedPeers = []; // no peers configured
    resolveTargetReturn = { type: "error", target: "phaith:hojo", detail: "no peer URL", hint: "" };

    await run(() => cmdSend("phaith:hojo", "ping"));

    const wakeCalls = curlFetchCalls.filter(c => c.url.includes("/api/wake"));
    expect(wakeCalls.length).toBe(0);
  });

  test("wake error surfaces and exits — does NOT proceed to /api/send", async () => {
    mockNamedPeers = [{ name: "phaith", url: "http://phaith:3456" }];
    curlFetchHandler = (url: string) => {
      if (url.includes("/api/wake")) return { ok: false, status: 503, data: { error: "peer unreachable" } };
      // /api/send mock would succeed, but should not be reached
      if (url.includes("/api/send")) return { ok: true, status: 200, data: { ok: true } };
      return { ok: false, status: 500, data: {} };
    };

    await run(() => cmdSend("phaith:hojo", "ping"));

    expect(exitCode).toBe(1);
    const sendCalls = curlFetchCalls.filter(c => c.url.includes("/api/send"));
    expect(sendCalls.length).toBe(0);
    const allErr = errs.join("\n");
    expect(allErr).toMatch(/cross-node wake failed/);
  });
});
