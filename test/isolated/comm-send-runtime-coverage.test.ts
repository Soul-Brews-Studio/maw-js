/**
 * Targeted isolated runtime coverage for src/commands/shared/comm-send.ts.
 *
 * These tests focus on remaining cmdSend branches that are awkward to cover
 * through live tmux/network state: idle retry recovery, receiver-inbox failure
 * fallback, forgiving ACL failures, and final receiver-inbox queue fallback.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

type ReceiverInboxInput = {
  query: string;
  target?: string;
  to: string;
  from: string;
  message: string;
  config: any;
};

type ReceiverInboxResult =
  | { ok: true; oracle: string; inboxDir: string; path: string; filename: string }
  | { ok: false; reason: string };

let config: any = { node: "test-node", oracle: "sender", host: "local", port: 3456, namedPeers: [] };
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let getPaneCommandReturn: string;
let captureResponses: string[];
let captureCalls: Array<{ target: string; lines: number; host?: string }>;
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchReturn: { ok: boolean; status?: number; data?: any };
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let sleepCalls: number[];
let loadScopesError: Error | null;
let defaultInboxCalls: ReceiverInboxInput[];
let defaultInboxResult: ReceiverInboxResult | null;

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
  capture: async (target: string, lines: number, host?: string) => {
    captureCalls.push({ target, lines, host });
    return captureResponses.length ? captureResponses.shift()! : "";
  },
  sendKeys: async (target: string, text: string) => {
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => getPaneCommandReturn,
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
  findPeerForTarget: async () => findPeerUrl,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return curlFetchReturn;
  },
  runHook: async (name: string, payload: any) => {
    runHookCalls.push({ name, payload });
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
  cfgLimit: () => 80,
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  logMessage: (from: string, to: string, message: string, route: string) => {
    logMessageCalls.push({ from, to, message, route });
  },
  emitFeed: (event: string, oracle: string, host: string, message: string, port: number, data: any) => {
    emitFeedCalls.push({ event, oracle, host, message, port, data });
  },
}));

mock.module(join(srcRoot, "src/commands/shared/scope-acl"), () => ({
  loadAllScopes: () => {
    if (loadScopesError) throw loadScopesError;
    return [];
  },
  evaluateAclFromDisk: () => "allow",
}));

mock.module(join(srcRoot, "src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async (input: ReceiverInboxInput) => {
    defaultInboxCalls.push(input);
    return defaultInboxResult;
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origTestMode = process.env.MAW_TEST_MODE;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
  sleepCalls.push(ms);
};

const { cmdSend } = await import("../../src/commands/shared/comm-send");

let exitCode: number | undefined;
let errs: string[];
let logs: string[];

async function runCmd(fn: () => Promise<unknown>) {
  exitCode = undefined;
  errs = [];
  logs = [];
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [] };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = ["❯ ", "accepted"];
  captureCalls = [];
  sendKeysCalls = [];
  curlFetchCalls = [];
  curlFetchReturn = { ok: true, status: 200, data: { ok: true, target: "receiver.0", state: "delivered" } };
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  sleepCalls = [];
  loadScopesError = null;
  defaultInboxCalls = [];
  defaultInboxResult = null;
  process.env.CLAUDE_AGENT_NAME = "sender";
  process.env.MAW_TEST_MODE = "1";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterEach(() => {
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = origTestMode;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend — targeted runtime coverage", () => {
  test("idle guard retries once and proceeds when the pane becomes idle", async () => {
    captureResponses = ["❯ partially typed", "❯ ", "delivered line"];

    await runCmd(() => cmdSend("local:session:oracle", "recover", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(sleepCalls).toEqual([500, 150]);
    expect(captureCalls.map((call) => call.lines)).toEqual([5, 5, 3]);
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] recover" }]);
    expect(logs.join("\n")).toContain("delivered");
  });

  test("receiver inbox writer errors do not hide the non-agent pane refusal", async () => {
    getPaneCommandReturn = "zsh";

    await runCmd(() => cmdSend("local:session:oracle", "offline", false, {
      receiverInbox: async () => {
        throw new Error("inbox disk full");
      },
    }));

    expect(exitCode).toBe(1);
    expect(sendKeysCalls).toEqual([]);
    expect(logMessageCalls).toEqual([]);
    expect(errs.join("\n")).toContain("no active Claude session");
    expect(errs.join("\n")).toContain("running: zsh");
  });

  test("ACL evaluation failures warn and still allow peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    loadScopesError = new Error("acl disk bad");

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("warn: ACL evaluation failed (acl disk bad); allowing send");
    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "receiver", text: "[test-node:sender] hello" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "delivered" });
    expect(emitFeedCalls[0].data.lastLine ?? "").toBe("");
  });

  test("unresolved local targets queue to receiver inbox before printing a miss", async () => {
    resolveTargetReturn = null;
    defaultInboxResult = {
      ok: true,
      oracle: "missing",
      inboxDir: "/repo/ψ/inbox",
      path: "/repo/ψ/inbox/msg.md",
      filename: "msg.md",
    };

    await runCmd(() => cmdSend("path/unknown", "poll me later"));

    expect(exitCode).toBeUndefined();
    expect(defaultInboxCalls).toEqual([{
      query: "path/unknown",
      target: undefined,
      to: "path/unknown",
      from: "test-node:sender",
      message: "[test-node:sender] poll me later",
      config,
    }]);
    expect(logMessageCalls).toEqual([{ from: "sender", to: "path/unknown", message: "[test-node:sender] poll me later", route: "inbox" }]);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "inbox", state: "queued", target: "path/unknown" });
    expect(logs.join("\n")).toContain("target not live; persisted for receiver inbox polling");
    expect(errs).toEqual([]);
  });
});
