/**
 * send-idle-guard.test.ts — checkPaneIdle heuristic + cmdSend idle-guard flow (#405).
 *
 * Tests:
 *   checkPaneIdle — prompt-marker heuristics (idle/not-idle/no-prompt cases)
 *   cmdSend idle guard — block on not-idle, retry once, pass on force=true
 *
 * Mocked seams: src/sdk, src/config, src/core/routing, src/core/runtime/hooks,
 *   src/commands/shared/comm-log-feed
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
const realCapture = _rSdk.capture;

// ─── Mutable stubs ───────────────────────────────────────────────────────────

let captureResponses: string[] = [];   // queue — each call pops from front
let sendKeysCalls: Array<{ target: string; text: string }> = [];
let getPaneCommandReturn = "claude";
let listSessionsReturn: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let resolveTargetReturn: { type: string; target: string } = { type: "local", target: "test-session:oracle" };
let sleepCalls: number[] = [];

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._rSdk,
  capture: async (...args: unknown[]) => {
    if (!mockActive) return (realCapture as (...a: unknown[]) => Promise<string>)(...args);
    return captureResponses.length > 0 ? captureResponses.shift()! : "";
  },
  sendKeys: async (target: string, text: string) => {
    if (!mockActive) return;
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => {
    if (!mockActive) return "";
    return getPaneCommandReturn;
  },
  listSessions: async () => {
    if (!mockActive) return [];
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

// Bun.sleep intercept — replace globally so checkPaneIdle retry doesn't stall
const origSleep = Bun.sleep.bind(Bun);
(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
  sleepCalls.push(ms);
};

// ─── Imports (after mocks) ────────────────────────────────────────────────────

const { checkPaneIdle } = await import("../../src/commands/shared/comm-send");
const { cmdSend } = await import("../../src/commands/shared/comm-send");

// ─── Harness ─────────────────────────────────────────────────────────────────

const origExit = process.exit;
const origErr = console.error;

let exitCode: number | undefined;
let errs: string[] = [];

async function run(fn: () => Promise<unknown>): Promise<void> {
  exitCode = undefined; errs = [];
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.error = origErr;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  captureResponses = [];
  sendKeysCalls = [];
  sleepCalls = [];
  getPaneCommandReturn = "claude";
  listSessionsReturn = [{ name: "test-session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "test-session:oracle.0" };
  delete process.env.MAW_QUIET;
  process.env.MAW_QUIET = "1"; // suppress tip output
});

afterEach(() => { mockActive = false; delete process.env.MAW_QUIET; });
afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
});

// ─── checkPaneIdle tests ─────────────────────────────────────────────────────

describe("checkPaneIdle — heuristic", () => {
  test("idle when last line ends with bare prompt marker ($)", async () => {
    captureResponses = ["user@host:~$ "];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(true);
    expect(result.lastInput).toBe("");
  });

  test("idle when last line ends with ❯ prompt (zsh)", async () => {
    captureResponses = ["❯ "];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(true);
  });

  test("not idle when user has typed after prompt ($)", async () => {
    captureResponses = ["user@host:~$ git push origin main"];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(false);
    expect(result.lastInput).toContain("git push");
  });

  test("not idle when user has typed after ❯ prompt", async () => {
    captureResponses = ["❯ maw hey le:hojo hi there"];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(false);
    expect(result.lastInput).toContain("maw");
  });

  test("idle when no prompt visible (agent output / running command)", async () => {
    captureResponses = ["Compiling maw-js v2.0.0-alpha.117\nFinished build in 3.2s"];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(true);
  });

  test("idle on capture error (conservative: don't block on unavailable pane)", async () => {
    // Simulate a pane that capture throws on — by passing a host that won't resolve
    // We can't easily throw from the mock, so test the exported function with a direct
    // throw-inducing path: we'll call with a real (non-mocked) context by temporarily
    // disabling the mock gate.
    mockActive = false;
    // checkPaneIdle catches all errors internally and returns idle=true
    const result = await checkPaneIdle("__nonexistent_pane_405__");
    expect(result.idle).toBe(true);
    mockActive = true;
  });

  test("strips ANSI codes before checking", async () => {
    // Pane contains ANSI-coloured prompt with user input
    captureResponses = ["\x1b[32muser@host\x1b[0m:\x1b[34m~\x1b[0m$ rm -rf /"];
    const result = await checkPaneIdle("test-session:oracle.0");
    expect(result.idle).toBe(false);
    expect(result.lastInput).toContain("rm");
  });

  test("uses last non-empty line (ignores blank trailing lines)", async () => {
    captureResponses = ["user@host:~$ git status\n\n\n"];
    const result = await checkPaneIdle("test-session:oracle.0");
    // "git status" is after prompt → not idle
    expect(result.idle).toBe(false);
  });
});

// ─── cmdSend idle-guard flow ─────────────────────────────────────────────────

describe("cmdSend — idle guard integration (#405)", () => {
  test("sends when pane is idle (prompt at end)", async () => {
    captureResponses = [
      "❯ ", // checkPaneIdle call (idle check)
      "",   // post-send capture for lastLine
    ];
    await run(() => cmdSend("test-node:oracle", "hello world"));
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0].text).toBe("hello world");
    expect(exitCode).toBeUndefined();
  });

  test("retries once and sends when second idle check passes", async () => {
    captureResponses = [
      "❯ git status",  // first checkPaneIdle → not idle
      "❯ ",            // second checkPaneIdle after 500ms sleep → idle
      "",              // post-send capture
    ];
    await run(() => cmdSend("test-node:oracle", "hello after retry"));
    expect(sleepCalls).toContain(500);
    expect(sendKeysCalls.length).toBe(1);
    expect(exitCode).toBeUndefined();
  });

  test("exits with code 1 when both idle checks fail", async () => {
    captureResponses = [
      "❯ git push",   // first checkPaneIdle → not idle
      "❯ git push",   // second checkPaneIdle → still not idle
    ];
    await run(() => cmdSend("test-node:oracle", "injected message"));
    expect(exitCode).toBe(1);
    expect(sendKeysCalls.length).toBe(0);
    const errText = errs.join("\n");
    expect(errText).toContain("not idle");
    expect(errText).toContain("--force");
  });

  test("bypasses idle check entirely with force=true", async () => {
    captureResponses = [
      // No idle-check capture should be called; only post-send capture
      "",
    ];
    await run(() => cmdSend("test-node:oracle", "forced message", /* force */ true));
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0].text).toBe("forced message");
    expect(exitCode).toBeUndefined();
    // No 500ms sleep should have been triggered by idle check
    expect(sleepCalls.filter(ms => ms === 500).length).toBe(0);
  });
});
