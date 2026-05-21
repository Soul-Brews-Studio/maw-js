/**
 * Deep isolated branch coverage for src/commands/shared/comm-send.ts.
 *
 * Fully mocked: no live tmux, network, inbox, ACL, consent, trust, or plugin
 * side effects. This file intentionally targets cmdSend branches not exercised
 * by the existing comm-send isolated suites.
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
type ReceiverInboxResult =
  | { ok: true; oracle: string; inboxDir: string; path: string; filename: string }
  | { ok: false; reason: string }
  | null;

let config: any;
let listSessionsReturn: any[];
let listSessionsCalls: number;
let resolveTargetReturn: ResolvedTarget;
let resolveTargetHandler: ((query: string) => ResolvedTarget) | null;
let findPeerUrl: string | null;
let getPaneCommandReturn: string;
let captureResponses: Array<string | Error>;
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchHandler: (url: string, options: any) => CurlResult | Promise<CurlResult>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let defaultInboxCalls: any[];
let defaultInboxResult: ReceiverInboxResult;
let plugins: Array<{ manifest: { name: string } }>;
let invokePluginResult: { ok: boolean; output?: string; error?: string };
let oracleMembers: string[];
let oracleRegistry: { members: string[] } | null;
let findOracleResult: any;
let shouldWakeHandler: ((target: string, input: any) => { wake: boolean }) | null;
let cmdWakeCalls: Array<{ oracle: string; opts: any }>;
let scopes: any[];
let aclDecision: "allow" | "queue";
let savePendingCalls: any[];
let trustAddCalls: Array<{ sender: string; target: string }>;
let trustAddError: Error | null;
let consentCalls: any[];
let consentDecision: { allow: boolean; message?: string; exitCode?: number };
let sleepCalls: number[];
let tmuxPaneList: string;

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return tmuxPaneList; }
    async tryRun() { return tmuxPaneList; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return listSessionsReturn;
  },
  capture: async () => {
    const next = captureResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
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
  cfgLimit: () => 40,
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
  defaultReceiverInboxWriter: () => async (input: any) => {
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
  shouldAutoWake: (target: string, input: any) => shouldWakeHandler?.(target, input) ?? { wake: false },
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
    return { id: "pending-deep", ...record };
  },
}));

mock.module(join(srcRoot, "src/lib/trust-store"), () => ({
  cmdAdd: (sender: string, target: string) => {
    if (trustAddError) throw trustAddError;
    trustAddCalls.push({ sender, target });
  },
}));

mock.module(join(srcRoot, "src/core/consent/gate"), () => ({
  maybeGateConsent: async (input: any) => {
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
  listSessionsCalls = 0;
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  resolveTargetHandler = null;
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = ["❯ ", "accepted after send"];
  sendKeysCalls = [];
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack", state: "delivered" } });
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  defaultInboxCalls = [];
  defaultInboxResult = null;
  plugins = [];
  invokePluginResult = { ok: true };
  oracleMembers = [];
  oracleRegistry = null;
  findOracleResult = undefined;
  shouldWakeHandler = null;
  cmdWakeCalls = [];
  scopes = [];
  aclDecision = "allow";
  savePendingCalls = [];
  trustAddCalls = [];
  trustAddError = null;
  consentCalls = [];
  consentDecision = { allow: true };
  sleepCalls = [];
  tmuxPaneList = "0 claude\n";
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

describe("comm-send deep isolated branches", () => {
  test("team fan-out rejects an empty team target with usage", async () => {
    await runCmd(() => cmdSend("team:", "hello"));

    expect(exitCode).toBe(1);
    expect(errs).toEqual(["usage: maw hey team:<team-name> <message>"]);
    expect(sendKeysCalls).toEqual([]);
  });

  test("team fan-out distinguishes sender-only registries from missing registries", async () => {
    oracleMembers = [];
    oracleRegistry = { members: ["sender"] };

    await runCmd(() => cmdSend("team:solo", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("team 'solo' has only the sender ('sender') as a member");
    expect(errs.join("\n")).toContain("excludeSelf:false");

    oracleRegistry = null;
    await runCmd(() => cmdSend("team:empty", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no oracle members in team 'empty'");
    expect(errs.join("\n")).toContain("maw team oracle-invite");
  });

  test("plugin routing reports missing plugins and plugin execution errors", async () => {
    await runCmd(() => cmdSend("plugin:missing", "hello"));

    expect(exitCode).toBe(1);
    expect(errs).toEqual(["plugin not found: missing"]);

    plugins = [{ manifest: { name: "broken" } }];
    invokePluginResult = { ok: false, error: "boom" };
    await runCmd(() => cmdSend("plugin:broken", "hello"));

    expect(exitCode).toBe(1);
    expect(errs).toEqual(["plugin error: boom"]);
  });

  test("local auto-wake refreshes sessions before resolving and delivering", async () => {
    config.node = "local";
    listSessionsReturn = [];
    findOracleResult = { name: "sleepy", node: "local" };
    shouldWakeHandler = (target, input) => {
      expect(target).toBe("sleepy");
      expect(input.manifest).toMatchObject({ name: "sleepy", isLive: false });
      return { wake: true };
    };
    resolveTargetHandler = () => ({ type: "local", target: "sleepy-session:sleepy-oracle.0" });
    cmdWakeCalls = [];
    captureResponses = ["❯ ", new Error("capture after send unavailable")];

    await runCmd(() => cmdSend("local:sleepy", "wake then send"));

    expect(exitCode).toBeUndefined();
    expect(cmdWakeCalls).toEqual([{ oracle: "sleepy", opts: {} }]);
    expect(listSessionsCalls).toBe(2);
    expect(sendKeysCalls).toEqual([{ target: "sleepy-session:sleepy-oracle.0", text: "[local:sender] wake then send" }]);
    expect(logs.join("\n")).toContain("'sleepy' is fleet-known — auto-wake");
    expect(emitFeedCalls[0].data).toMatchObject({ route: "local", state: "delivered" });
    expect(emitFeedCalls[0].data).not.toHaveProperty("lastLine");
  });

  test("approved trust persistence records the pair before peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };

    await runCmd(() => cmdSend("remote:session:receiver", "approved", false, {
      approve: true,
      trust: true,
      receiverInbox: false,
    }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([{ sender: "sender", target: "receiver" }]);
    expect(logs.join("\n")).toContain("trusted sender ↔ receiver");
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "remote:session:receiver", message: "[test-node:sender] approved" } }]);
  });

  test("consent denial prints the provided message and exits with the provided code", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    process.env.MAW_CONSENT = "1";
    consentDecision = { allow: false, message: "consent required: request-123", exitCode: 7 };

    await runCmd(() => cmdSend("remote:session:receiver", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(7);
    expect(errs).toEqual(["consent required: request-123"]);
    expect(consentCalls).toHaveLength(1);
    expect(curlFetchCalls).toEqual([]);
  });

  test("receiver inbox queue handles non-agent panes without tmux delivery", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    getPaneCommandReturn = "vim";
    defaultInboxResult = { ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" };

    await runCmd(() => cmdSend("local:session:oracle", "queued draft"));

    expect(exitCode).toBeUndefined();
    expect(defaultInboxCalls[0]).toMatchObject({
      query: "local:session:oracle",
      target: "session:oracle.0",
      from: "test-node:sender",
      message: "[test-node:sender] queued draft",
    });
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:session:oracle", message: "[test-node:sender] queued draft", route: "inbox" }]);
    expect(emitFeedCalls[0].data).toMatchObject({ state: "queued", route: "inbox", lastLine: "pane not running an agent (vim)" });
    expect(sendKeysCalls).toEqual([]);
    expect(logs.join("\n")).toContain("queued");
  });

  test("receiver inbox queue handles persistently busy panes after retry", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    captureResponses = ["❯ composing reply", "❯ still typing"];
    defaultInboxResult = { ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/busy.md", filename: "busy.md" };

    await runCmd(() => cmdSend("local:session:oracle", "please read later"));

    expect(exitCode).toBeUndefined();
    expect(sleepCalls).toEqual([500]);
    expect(defaultInboxCalls).toHaveLength(1);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "inbox", lastLine: "pane not idle: still typing" });
    expect(sendKeysCalls).toEqual([]);
  });

  test("resolver miss with known agents prints the fallback known-agents hint", async () => {
    config.agents = { alpha: {}, beta: {} };
    resolveTargetReturn = null;
    findPeerUrl = null;
    defaultInboxResult = null;

    await runCmd(() => cmdSend("local:ghost", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window not found: local:ghost");
    expect(errs.join("\n")).toContain("known agents: alpha, beta");
  });

  test("team fan-out counts delivered, member exits, and thrown member failures", async () => {
    oracleMembers = ["good", "exit", "thrower"];
    oracleRegistry = { members: ["sender", "good", "exit", "thrower"] };
    resolveTargetHandler = (query) => {
      if (query === "good") return { type: "local", target: "session:good.0" };
      if (query === "thrower") throw new Error("fanout boom");
      return null;
    };
    captureResponses = ["❯ ", "fanout accepted"];

    await runCmd(() => cmdSend("team:squad", "fan out"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:good.0", text: "[test-node:sender] fan out" }]);
    expect(logs.join("\n")).toContain("self 'sender' excluded");
    expect(logs.join("\n")).toContain("fan-out complete: 1 delivered, 2 failed");
    expect(errs.join("\n")).toContain("bare target 'exit' not found locally");
    expect(errs.join("\n")).toContain("thrower: fanout boom");
  });

  test("ACL queue records pending peer sends before network delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopes = [{ name: "prod" }];
    aclDecision = "queue";

    await runCmd(() => cmdSend("remote:session:receiver", "needs review", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(savePendingCalls).toEqual([{ sender: "sender", target: "receiver", message: "needs review", query: "remote:session:receiver" }]);
    expect(curlFetchCalls).toEqual([]);
    expect(logs.join("\n")).toContain("queued for approval");
    expect(logs.join("\n")).toContain("maw inbox approve pending-deep");
  });

  test("discovery fallback success emits delivery and runs after_send", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "ghost.0", lastLine: "received", state: "delivered" } });

    await runCmd(() => cmdSend("local:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls[0].url).toBe("http://discovered:3456/api/send");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "local:ghost", text: "[test-node:sender] hello" });
    expect(logMessageCalls[0]).toMatchObject({ route: "discovery", message: "[test-node:sender] hello" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "delivered", target: "ghost.0", lastLine: "received" });
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:ghost", message: "[test-node:sender] hello" } }]);
  });

});
