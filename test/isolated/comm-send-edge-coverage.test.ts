/**
 * Isolated edge-branch coverage for src/commands/shared/comm-send.ts.
 *
 * Keep this file test-only and fully mocked: no live tmux, network, inbox, or
 * trust-store side effects. The cases target small uncovered branches that are
 * hard to hit from the broader cmdSend coverage suite.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { AmbiguousMatchError } from "../../src/core/runtime/find-window";

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

let config: any;
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let resolveTargetHandler: ((query: string) => ResolvedTarget) | null;
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
let defaultInboxResult: any;
let plugins: Array<{ manifest: { name: string } }>;
let invokePluginResult: { ok: boolean; output?: string; error?: string };
let oracleMembers: string[];
let oracleRegistry: { members: string[] } | null;
let shouldWake: boolean;
let findOracleResult: any;
let cmdWakeCalls: Array<{ oracle: string; opts: any }>;
let scopes: any[];
let aclDecision: "allow" | "queue";
let savePendingCalls: any[];
let consentDecision: { allow: boolean; message?: string; exitCode?: number };
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
  resolveTarget: (query: string) => resolveTargetHandler ? resolveTargetHandler(query) : resolveTargetReturn,
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
    return defaultInboxResult;
  },
}));

mock.module(join(srcRoot, "src/plugin/registry"), () => ({
  discoverPackages: () => plugins,
  invokePlugin: async () => invokePluginResult,
}));

mock.module(join(srcRoot, "src/lib/oracle-members"), () => ({
  getOracleMembers: () => oracleMembers,
  loadOracleRegistry: () => oracleRegistry,
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
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
  loadAllScopes: () => scopes,
  evaluateAclFromDisk: () => aclDecision,
}));

mock.module(join(srcRoot, "src/commands/shared/queue-store"), () => ({
  savePending: (record: any) => {
    savePendingCalls.push(record);
    return { id: "pending-edge", ...record };
  },
}));

mock.module(join(srcRoot, "src/core/consent/gate"), () => ({
  maybeGateConsent: async () => consentDecision,
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
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
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [] };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  resolveTargetHandler = null;
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
  defaultInboxResult = null;
  plugins = [];
  invokePluginResult = { ok: true };
  oracleMembers = [];
  oracleRegistry = null;
  shouldWake = false;
  findOracleResult = undefined;
  cmdWakeCalls = [];
  scopes = [];
  aclDecision = "allow";
  savePendingCalls = [];
  consentDecision = { allow: true };
  process.env.CLAUDE_AGENT_NAME = "sender";
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
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("comm-send edge branch coverage", () => {
  test("plugin success without output prints the explicit no-output placeholder", async () => {
    plugins = [{ manifest: { name: "noop" } }];
    invokePluginResult = { ok: true };

    await runCmd(() => cmdSend("plugin:noop", "hello"));

    expect(exitCode).toBeUndefined();
    expect(logs).toEqual(["(no output)"]);
    expect(sendKeysCalls).toEqual([]);
  });

  test("bare ambiguous targets with no candidates fall back to the query in guidance", async () => {
    resolveTargetHandler = () => { throw new AmbiguousMatchError("oracle", []); };

    await runCmd(() => cmdSend("oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("matches 1 local windows");
    expect(errs.join("\n")).toContain("oracle");
  });

  test("team fan-out counts delivered, process-exit failures, and thrown failures", async () => {
    oracleMembers = ["good", "exit", "thrower"];
    oracleRegistry = { members: ["good", "exit", "thrower"] };
    resolveTargetHandler = (query) => {
      if (query === "good") return { type: "local", target: "session:good.0" };
      if (query === "thrower") throw new Error("boom");
      return null;
    };

    await runCmd(() => cmdSend("team:squad", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:good.0", text: "[test-node:sender] hello" }]);
    expect(logs.join("\n")).toContain("fan-out to 3 oracle(s) in team 'squad':");
    expect(logs.join("\n")).not.toContain("self 'sender' excluded");
    expect(logs.join("\n")).toContain("fan-out complete: 1 delivered, 2 failed");
    expect(errs.join("\n")).toContain("bare target 'exit' not found locally");
    expect(errs.join("\n")).toContain("thrower: boom");
  });

  test("cross-node wake failures surface connection-failed before send", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    shouldWake = true;
    curlFetchHandler = () => ({ ok: false });

    await runCmd(() => cmdSend("remote:oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls.map((call) => call.url)).toEqual(["http://remote:3456/api/wake"]);
    expect(errs.join("\n")).toContain("cross-node wake failed for oracle: connection failed");
  });

  test("ACL queue branch records pending peer sends and returns before delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopes = [{ name: "edge" }];
    aclDecision = "queue";

    await runCmd(() => cmdSend("remote:session:receiver", "needs approval"));

    expect(exitCode).toBeUndefined();
    expect(savePendingCalls).toEqual([{ sender: "sender", target: "receiver", message: "needs approval", query: "remote:session:receiver" }]);
    expect(curlFetchCalls).toEqual([]);
    expect(logs.join("\n")).toContain("queued for approval");
  });

  test("consent denials without an explicit code exit with code 1", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    process.env.MAW_CONSENT = "1";
    consentDecision = { allow: false };

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls).toEqual([]);
  });

  test("peer send failures without status use the connection-failed fallback", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: false });

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "failed", error: "connection failed" });
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://remote:3456 (remote): connection failed");
  });
});
