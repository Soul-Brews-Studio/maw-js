/**
 * Additional isolated coverage for src/commands/shared/comm-send.ts.
 *
 * Test-only slice: exercises wake/trust branches without live tmux, network,
 * inbox, or trust-store side effects.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

type CurlResult = { ok: boolean; status?: number; data?: any };

type ReceiverInboxInput = {
  query: string;
  target?: string;
  to: string;
  from: string;
  message: string;
  config: any;
};

let config: any = { node: "test-node", oracle: "sender", host: "local", port: 3456, namedPeers: [], commands: { default: "claude" } };
let listSessionsQueue: any[][];
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let getPaneCommandReturn: string;
let captureResponses: string[];
let sendKeysCalls: Array<{ target: string; text: string }>;
let captureCalls: Array<{ target: string; lines: number; host?: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchHandler: (url: string, options: any) => CurlResult | Promise<CurlResult>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let defaultInboxCalls: ReceiverInboxInput[];
let shouldWake: boolean;
let findOracleResult: any;
let cmdWakeCalls: Array<{ oracle: string; opts: any }>;
let trustAddCalls: Array<{ sender: string; target: string }>;
let trustAddError: Error | null;

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux(), tmuxCmd: () => "tmux", resolveSocket: () => undefined };
});

mock.module(join(srcRoot, "src/sdk/index.ts"), () => ({
  listSessions: async () => listSessionsQueue.length > 1 ? listSessionsQueue.shift()! : listSessionsQueue[0],
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
    return curlFetchHandler(url, options);
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

mock.module(join(srcRoot, "src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async (input: ReceiverInboxInput) => {
    defaultInboxCalls.push(input);
    return null;
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => [],
  findOracle: () => findOracleResult,
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: shouldWake }),
}));

mock.module(join(srcRoot, "src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (oracle: string, opts: any) => {
    cmdWakeCalls.push({ oracle, opts });
  },
}));

mock.module(join(srcRoot, "src/commands/shared/scope-acl"), () => ({
  loadAllScopes: () => [],
  evaluateAclFromDisk: () => "allow",
}));

mock.module(join(srcRoot, "src/lib/trust-store"), () => ({
  cmdAdd: (sender: string, target: string) => {
    if (trustAddError) throw trustAddError;
    trustAddCalls.push({ sender, target });
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;
const origConsent = process.env.MAW_CONSENT;
const origAclBypass = process.env.MAW_ACL_BYPASS;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

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
  listSessionsQueue = [[{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }]];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = ["❯ ", "accepted"];
  sendKeysCalls = [];
  captureCalls = [];
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack" } });
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  defaultInboxCalls = [];
  shouldWake = false;
  findOracleResult = undefined;
  cmdWakeCalls = [];
  trustAddCalls = [];
  trustAddError = null;
  process.env.CLAUDE_AGENT_NAME = "sender";
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origSshClient === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = origSshClient;
  if (origSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = origSshConnection;
  if (origSshTty === undefined) delete process.env.SSH_TTY;
  else process.env.SSH_TTY = origSshTty;
  if (origConsent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = origConsent;
  if (origAclBypass === undefined) delete process.env.MAW_ACL_BYPASS;
  else process.env.MAW_ACL_BYPASS = origAclBypass;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend — more isolated coverage", () => {
  test("local explicit-node targets auto-wake fleet-known oracles, refresh sessions, then deliver", async () => {
    config.node = "local";
    listSessionsQueue = [
      [{ name: "other", windows: [] }],
      [{ name: "sleeper", windows: [{ index: 0, name: "sleeper-oracle", active: true }] }],
    ];
    findOracleResult = { name: "sleeper", node: "local", isLive: false };
    shouldWake = true;
    resolveTargetReturn = { type: "local", target: "sleeper:sleeper-oracle.0" };

    await runCmd(() => cmdSend("local:sleeper", "wake then send", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(cmdWakeCalls).toEqual([{ oracle: "sleeper", opts: {} }]);
    expect(logs.join("\n")).toContain("'sleeper' is fleet-known — auto-wake");
    expect(sendKeysCalls).toEqual([{ target: "sleeper:sleeper-oracle.0", text: "[local:sender] wake then send" }]);
  });

  test("cross-node auto-wake success signs wake before signed peer delivery", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    shouldWake = true;
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = (url) => url.endsWith("/api/wake")
      ? { ok: true, status: 200, data: { ok: true } }
      : { ok: true, status: 200, data: { ok: true, target: "oracle.0", state: "queued", lastLine: "queued remotely" } };

    await runCmd(() => cmdSend("remote:oracle", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map((call) => call.url)).toEqual([
      "http://remote:3456/api/wake",
      "http://remote:3456/api/send",
    ]);
    expect(curlFetchCalls.map((call) => call.options.from)).toEqual(["auto", "auto"]);
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "oracle" });
    expect(JSON.parse(curlFetchCalls[1].options.body)).toEqual({ target: "oracle", text: "[test-node:sender] hello" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "queued", target: "oracle.0" });
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "remote:oracle", message: "[test-node:sender] hello" } }]);
  });

  // kobo-474 — RENAMED + assertions updated (config-oracle-fallback behavior
  // intentionally withdrawn, not a regression). Old name/assertions pinned
  // aclSenderOracle's pre-kobo-474 bug directly: on the "auto" source path it
  // discarded the already-correctly-resolved sender identity (senderName, set
  // from CLAUDE_AGENT_NAME="sender" in this file's beforeEach) and substituted
  // config.oracle instead — so deleting config.oracle produced the "mawjs"
  // fallback this test asserted on. aclSenderOracle now always returns
  // senderIdentity.senderName regardless of config.oracle; deleting
  // config.oracle here no longer has any effect on who gets attributed as
  // sender, which is the fix working as intended (kobo-474 threat model: ACL
  // subject is the resolved identity, never a node-static config value).
  test("approved trust persistence uses the resolved sender identity, unaffected by config.oracle", async () => {
    delete config.oracle;
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };

    await runCmd(() => cmdSend("remote:session:receiver", "approved", false, {
      approve: true,
      trust: true,
      receiverInbox: false,
    }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([{ sender: "sender", target: "receiver" }]); // CLAUDE_AGENT_NAME, set in beforeEach — not config.oracle
    expect(logs.join("\n")).toContain("trusted sender ↔ receiver");
    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(logMessageCalls[0]).toMatchObject({ route: "peer:remote", message: "[test-node:sender] approved" });
  });
});
