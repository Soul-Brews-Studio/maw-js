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

let config: any = { node: "test-node", oracle: "sender", host: "local", port: 3456, namedPeers: [], commands: { default: "claude" } };
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
  return { Tmux: MockTmux, tmux: new MockTmux(), tmuxCmd: () => "tmux", resolveSocket: () => undefined };
});

mock.module(join(srcRoot, "src/sdk/index.ts"), () => ({
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
const origFetch = globalThis.fetch;
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;
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
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [], commands: { default: "claude" } };
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
  // eq3-003 defer path uses global fetch — stub away from the live local server.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  process.env.MAW_TEST_MODE = "1";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterEach(() => {
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origSshClient === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = origSshClient;
  if (origSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = origSshConnection;
  if (origSshTty === undefined) delete process.env.SSH_TTY;
  else process.env.SSH_TTY = origSshTty;
  if (origTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = origTestMode;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  globalThis.fetch = origFetch;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend — targeted runtime coverage", () => {
  test("eq3-003: defers (no overtype) when the prompt holds operator input", async () => {
    captureResponses = ["❯ partially typed"]; // dirty → defer, not inject

    await runCmd(() => cmdSend("local:session:oracle", "recover", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    // Pane-input guard reads exactly one capture (5 lines) and bails before send.
    expect(captureCalls.map((call) => call.lines)).toEqual([12]);
    expect(sendKeysCalls).toEqual([]);
    expect(logs.join("\n")).toContain("operator input mid-edit");
  });

  test("delivers normally when the prompt is clean", async () => {
    captureResponses = ["❯ ", "delivered line"];

    await runCmd(() => cmdSend("local:session:oracle", "recover", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] recover" }]);
    expect(logs.join("\n")).toContain("delivered");
  });

  test("receiver inbox writer errors do not block default local delivery", async () => {
    getPaneCommandReturn = "zsh";
    captureResponses = ["delivered"];

    await runCmd(() => cmdSend("local:session:oracle", "offline", false, {
      receiverInbox: async () => {
        throw new Error("inbox disk full");
      },
    }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] offline" }]);
    expect(logMessageCalls[0]).toMatchObject({ route: "local" });
    expect(errs.join("\n")).not.toContain("no active Claude session");
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
    expect(logs.join("\n")).toContain("they'll read it on the next poll");
    expect(errs).toEqual([]);
  });
});
