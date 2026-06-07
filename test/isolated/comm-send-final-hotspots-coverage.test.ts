/**
 * Final isolated hotspot coverage for src/commands/shared/comm-send.ts.
 *
 * Focus:
 * - ACL bypass env path skips the queue gate entirely
 * - consent-enabled peer sends still continue when allowed
 * - receiver inbox negative/throw fallbacks do not hide the primary send path result
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

let config: any;
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let getPaneCommandReturn: string;
let captureResponses: string[];
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchReturn: { ok: boolean; status?: number; data?: any };
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let loadScopesCalls: number;
let scopes: any[];
let aclDecision: string;
let consentDecision: { allow: boolean; message?: string; exitCode?: number };
let consentCalls: Array<{ myNode: string; resolved: ResolvedTarget; query: string; message: string }>;
let defaultInboxCalls: ReceiverInboxInput[];
let defaultInboxResult: ReceiverInboxResult | null;
let sleepCalls: number[];

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
  capture: async () => captureResponses.shift() ?? "",
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
    loadScopesCalls += 1;
    return scopes;
  },
  evaluateAclFromDisk: () => aclDecision,
}));

mock.module(join(srcRoot, "src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async (input: ReceiverInboxInput) => {
    defaultInboxCalls.push(input);
    return defaultInboxResult;
  },
}));

mock.module(join(srcRoot, "src/core/consent/gate"), () => ({
  maybeGateConsent: async (input: { myNode: string; resolved: ResolvedTarget; query: string; message: string }) => {
    consentCalls.push(input);
    return consentDecision;
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origConsent = process.env.MAW_CONSENT;
const origAclBypass = process.env.MAW_ACL_BYPASS;
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
  sendKeysCalls = [];
  curlFetchCalls = [];
  curlFetchReturn = { ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack" } };
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  loadScopesCalls = 0;
  scopes = [];
  aclDecision = "allow";
  consentDecision = { allow: true };
  consentCalls = [];
  defaultInboxCalls = [];
  defaultInboxResult = null;
  sleepCalls = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
  process.env.MAW_TEST_MODE = "1";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origConsent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = origConsent;
  if (origAclBypass === undefined) delete process.env.MAW_ACL_BYPASS;
  else process.env.MAW_ACL_BYPASS = origAclBypass;
  if (origTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = origTestMode;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("comm-send final hotspots", () => {
  test("MAW_ACL_BYPASS skips ACL queue checks and still delivers peer sends", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopes = [{ name: "prod" }];
    aclDecision = "queue";
    process.env.MAW_ACL_BYPASS = "1";

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBeUndefined();
    expect(loadScopesCalls).toBe(0);
    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({
      target: "receiver",
      text: "[test-node:sender] hello",
    });
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "remote:session:receiver", message: "[test-node:sender] hello" } }]);
  });

  test("consent-allowed peer sends still continue to delivery when MAW_CONSENT=1", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    process.env.MAW_CONSENT = "1";

    await runCmd(() => cmdSend("remote:session:receiver", "ping"));

    expect(exitCode).toBeUndefined();
    expect(consentCalls).toEqual([{ 
      myNode: "test-node",
      resolved: { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" },
      query: "remote:session:receiver",
      message: "ping",
    }]);
    expect(curlFetchCalls).toHaveLength(1);
    expect(logMessageCalls[0]).toMatchObject({ route: "peer:remote", message: "[test-node:sender] ping" });
  });

  test("--inbox surfaces receiver inbox ok:false as a queue-only error", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    getPaneCommandReturn = "vim";

    await runCmd(() => cmdSend("local:session:oracle", "draft", false, {
      inboxOnly: true,
      receiverInbox: async () => ({ ok: false, reason: "mailbox offline" }),
    }));

    expect(exitCode).toBe(1);
    expect(sendKeysCalls).toEqual([]);
    expect(logMessageCalls).toEqual([]);
    expect(errs.join("\n")).toContain("--inbox requested");
    expect(errs.join("\n")).toContain("mailbox offline");
  });

  test("receiver inbox writer exceptions do not block successful local delivery", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    captureResponses = ["❯ ", "line after send"];

    await runCmd(() => cmdSend("local:session:oracle", "ship it", false, {
      receiverInbox: async () => {
        throw new Error("disk full");
      },
    }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] ship it" }]);
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:session:oracle", message: "[test-node:sender] ship it" } }]);
    expect(logMessageCalls[0]).toMatchObject({ route: "local", message: "[test-node:sender] ship it" });
    expect(sleepCalls).toEqual([150]);
    expect(logs.join("\n")).toContain("delivered");
  });

  test("receiver inbox returning ok:false does not hide resolver detail on final miss", async () => {
    resolveTargetReturn = { type: "error", detail: "window missing", hint: "run maw ls -v" };

    await runCmd(() => cmdSend("local:ghost", "hello", false, {
      receiverInbox: async () => ({ ok: false, reason: "queue disabled" }),
    }));

    expect(exitCode).toBe(1);
    expect(defaultInboxCalls).toEqual([]);
    expect(errs.join("\n")).toContain("window missing");
    expect(errs.join("\n")).toContain("run maw ls -v");
  });
});
