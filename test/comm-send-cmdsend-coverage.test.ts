/**
 * cmdSend coverage without live tmux or network.
 *
 * This file stays in the main test suite (not test/isolated) so it contributes
 * to `test:coverage`. Mocks are gated: when mockActive=false, they delegate to
 * the real modules so later tests do not inherit fake behavior.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let mockActive = false;

const _rSdk = await import("../src/sdk");
const _rConfig = await import("../src/config");
const _rFeed = await import("../src/commands/shared/comm-log-feed");
const _rRegistry = await import("../src/plugin/registry");
const _rOracleMembers = await import("../src/lib/oracle-members");
const _rOracleManifest = await import("../src/lib/oracle-manifest");
const _rWakeCmd = await import("../src/commands/shared/wake-cmd");
const _rScopeAcl = await import("../src/commands/shared/scope-acl");
const _rQueueStore = await import("../src/commands/shared/queue-store");
const _rTrustStore = await import("../src/lib/trust-store");
const _rConsentGate = await import("../src/core/consent/gate");
const _rEventHooks = await import("../src/plugin/event-hooks");
const _rFindWindow = await import("../src/core/runtime/find-window");
const realSdk = {
  listSessions: _rSdk.listSessions,
  capture: _rSdk.capture,
  sendKeys: _rSdk.sendKeys,
  getPaneCommand: _rSdk.getPaneCommand,
  isAgentCommand: _rSdk.isAgentCommand,
  resolveTarget: _rSdk.resolveTarget,
  curlFetch: _rSdk.curlFetch,
  runHook: _rSdk.runHook,
  findPeerForTarget: _rSdk.findPeerForTarget,
};
const realConfig = { loadConfig: _rConfig.loadConfig, cfgLimit: _rConfig.cfgLimit };
const realFeed = { logMessage: _rFeed.logMessage, emitFeed: _rFeed.emitFeed };
const realRegistry = { discoverPackages: _rRegistry.discoverPackages, invokePlugin: _rRegistry.invokePlugin };
const realOracleMembers = { getOracleMembers: _rOracleMembers.getOracleMembers, loadOracleRegistry: _rOracleMembers.loadOracleRegistry };
const realOracleManifest = { findOracle: _rOracleManifest.findOracle, loadManifestCached: _rOracleManifest.loadManifestCached };
const realWakeCmd = { cmdWake: _rWakeCmd.cmdWake };
const realScopeAcl = { loadAllScopes: _rScopeAcl.loadAllScopes, evaluateAclFromDisk: _rScopeAcl.evaluateAclFromDisk };
const realQueueStore = { savePending: _rQueueStore.savePending };
const realTrustStore = { cmdAdd: _rTrustStore.cmdAdd };
const realConsentGate = { maybeGateConsent: _rConsentGate.maybeGateConsent };
const realEventHooks = { runPluginEventHooks: _rEventHooks.runPluginEventHooks };

type Session = { name: string; windows: Array<{ index: number; name: string; active: boolean }> };
type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; target?: string; detail: string; hint?: string }
  | null;

type CurlResult = { ok: boolean; status?: number; data?: any };

type PluginPackage = { manifest: { name: string } };

let config: any;
let listSessionsReturn: Session[];
let resolveTargetReturn: ResolvedTarget;
let resolveTargetError: Error | null;
let resolveTargetCalls: string[];
let resolveTargetArgCalls: Parameters<typeof _rSdk.resolveTarget>[];
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
let sleepCalls: number[];
let plugins: PluginPackage[];
let invokePluginResult: { ok: boolean; output?: string; error?: string };
let oracleMembers: string[];
let oracleRegistry: { members: string[] } | null;
let findOracleResult: any;
let manifestEntries: any[];
let cmdWakeCalls: Array<{ oracle: string; opts: any }>;
let scopes: any[];
let aclError: Error | null;
let aclDecision: "allow" | "queue";
let savePendingCalls: any[];
let trustAddCalls: Array<{ sender: string; target: string }>;
let trustAddError: Error | null;
let consentDecision: { allow: boolean; message?: string; exitCode?: number };
let transportEventCalls: Array<{ eventName: string; payload: unknown }>;

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ..._rSdk,
  listSessions: async () => mockActive ? listSessionsReturn : realSdk.listSessions(),
  capture: async (target: string, lines: number, host?: string) => {
    if (!mockActive) return realSdk.capture(target, lines, host);
    captureCalls.push({ target, lines, host });
    return captureResponses.length ? captureResponses.shift()! : "";
  },
  sendKeys: async (target: string, text: string) => {
    if (!mockActive) return realSdk.sendKeys(target, text);
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => mockActive ? getPaneCommandReturn : realSdk.getPaneCommand(""),
  isAgentCommand: (cmd: string | null | undefined) => {
    if (!mockActive) return realSdk.isAgentCommand(cmd);
    return ["claude", "codex", "node"].includes((cmd ?? "").trim());
  },
  findPeerForTarget: async (...args: Parameters<typeof realSdk.findPeerForTarget>) => mockActive ? findPeerUrl : realSdk.findPeerForTarget(...args),
  resolveTarget: (...args: Parameters<typeof _rSdk.resolveTarget>) => {
    if (!mockActive) return realSdk.resolveTarget(...args);
    resolveTargetCalls.push(args[0]);
    resolveTargetArgCalls.push(args);
    if (resolveTargetError) throw resolveTargetError;
    if (resolveTargetHandler) return resolveTargetHandler(args[0]);
    return resolveTargetReturn as ReturnType<typeof _rSdk.resolveTarget>;
  },
  curlFetch: async (url: string, options: any) => {
    if (!mockActive) return realSdk.curlFetch(url, options);
    curlFetchCalls.push({ url, options });
    return curlFetchHandler(url, options);
  },
  runHook: async (name: string, payload: any) => {
    if (!mockActive) return realSdk.runHook(name, payload);
    runHookCalls.push({ name, payload });
  },
}));

mock.module(join(import.meta.dir, "../src/config"), () => ({
  ..._rConfig,
  loadConfig: () => mockActive ? config : realConfig.loadConfig(),
  cfgLimit: (key: Parameters<typeof _rConfig.cfgLimit>[0]) => mockActive ? 100 : realConfig.cfgLimit(key),
}));

mock.module(join(import.meta.dir, "../src/commands/shared/comm-log-feed"), () => ({
  ..._rFeed,
  logMessage: (from: string, to: string, message: string, route: string) => {
    if (!mockActive) return realFeed.logMessage(from, to, message, route);
    logMessageCalls.push({ from, to, message, route });
  },
  emitFeed: (event: string, oracle: string, host: string, message: string, port: number, data: any) => {
    if (!mockActive) return realFeed.emitFeed(event, oracle, host, message, port, data);
    emitFeedCalls.push({ event, oracle, host, message, port, data });
  },
}));

mock.module(join(import.meta.dir, "../src/plugin/registry"), () => ({
  ..._rRegistry,
  discoverPackages: () => mockActive ? plugins : realRegistry.discoverPackages(),
  invokePlugin: async (...args: Parameters<typeof realRegistry.invokePlugin>) => mockActive ? invokePluginResult : realRegistry.invokePlugin(...args),
}));

mock.module(join(import.meta.dir, "../src/lib/oracle-members"), () => ({
  ..._rOracleMembers,
  getOracleMembers: (...args: Parameters<typeof realOracleMembers.getOracleMembers>) => mockActive ? oracleMembers : realOracleMembers.getOracleMembers(...args),
  loadOracleRegistry: (...args: Parameters<typeof realOracleMembers.loadOracleRegistry>) => mockActive ? oracleRegistry : realOracleMembers.loadOracleRegistry(...args),
}));

mock.module(join(import.meta.dir, "../src/lib/oracle-manifest"), () => ({
  ..._rOracleManifest,
  findOracle: (name: string) => mockActive ? findOracleResult : realOracleManifest.findOracle(name),
  loadManifestCached: () => mockActive ? manifestEntries : realOracleManifest.loadManifestCached(),
}));

mock.module(join(import.meta.dir, "../src/commands/shared/wake-cmd"), () => ({
  ..._rWakeCmd,
  cmdWake: async (oracle: string, opts: any) => {
    if (!mockActive) return realWakeCmd.cmdWake(oracle, opts);
    cmdWakeCalls.push({ oracle, opts });
    return `${oracle}-session`;
  },
}));

mock.module(join(import.meta.dir, "../src/commands/shared/scope-acl"), () => ({
  ..._rScopeAcl,
  loadAllScopes: () => {
    if (!mockActive) return realScopeAcl.loadAllScopes();
    if (aclError) throw aclError;
    return scopes;
  },
  evaluateAclFromDisk: () => {
    if (!mockActive) return realScopeAcl.evaluateAclFromDisk("", "");
    if (aclError) throw aclError;
    return aclDecision;
  },
}));

mock.module(join(import.meta.dir, "../src/commands/shared/queue-store"), () => ({
  ..._rQueueStore,
  savePending: (record: any) => {
    if (!mockActive) return realQueueStore.savePending(record);
    savePendingCalls.push(record);
    return { id: "pending-1", ...record };
  },
}));

mock.module(join(import.meta.dir, "../src/lib/trust-store"), () => ({
  ..._rTrustStore,
  cmdAdd: (sender: string, target: string) => {
    if (!mockActive) return realTrustStore.cmdAdd(sender, target);
    if (trustAddError) throw trustAddError;
    trustAddCalls.push({ sender, target });
  },
}));

mock.module(join(import.meta.dir, "../src/core/consent/gate"), () => ({
  ..._rConsentGate,
  maybeGateConsent: async (...args: Parameters<typeof realConsentGate.maybeGateConsent>) => mockActive ? consentDecision : realConsentGate.maybeGateConsent(...args),
}));

mock.module(join(import.meta.dir, "../src/plugin/event-hooks"), () => ({
  ..._rEventHooks,
  runPluginEventHooks: async (...args: Parameters<typeof realEventHooks.runPluginEventHooks>) => {
    if (!mockActive) return realEventHooks.runPluginEventHooks(...args);
    const [eventName, payload] = args;
    transportEventCalls.push({ eventName, payload });
    return { eventName, matched: 0, invoked: 0, skipped: 0, failed: 0 };
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origWarn = console.warn;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origTestMode = process.env.MAW_TEST_MODE;
const origMawSender = process.env.MAW_SENDER;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
  if (mockActive) sleepCalls.push(ms);
  else await origSleep(ms);
};

const { cmdSend } = await import("../src/commands/shared/comm-send");

let exitCode: number | undefined;
let errs: string[];
let logs: string[];
let warns: string[];

// These locate/manifest fallback cases exercise intentionally slow negative-path
// waits; under isolated shard load the default 5s per-test cap flakes.
const COMM_SEND_LOCATE_TIMEOUT_MS = 10_000;

async function runCmd(fn: () => Promise<unknown>) {
  exitCode = undefined;
  errs = [];
  logs = [];
  warns = [];
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
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
    console.warn = origWarn;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [] };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  resolveTargetError = null;
  resolveTargetCalls = [];
  resolveTargetArgCalls = [];
  resolveTargetHandler = null;
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = ["❯ ", "accepted"];
  sendKeysCalls = [];
  captureCalls = [];
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "remote:0", lastLine: "ack" } });
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  sleepCalls = [];
  plugins = [];
  invokePluginResult = { ok: true, output: "plugin ok" };
  oracleMembers = [];
  oracleRegistry = null;
  findOracleResult = undefined;
  manifestEntries = [];
  cmdWakeCalls = [];
  scopes = [];
  aclError = null;
  aclDecision = "allow";
  savePendingCalls = [];
  trustAddCalls = [];
  trustAddError = null;
  consentDecision = { allow: true };
  transportEventCalls = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
  process.env.MAW_TEST_MODE = "1";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
  delete process.env.MAW_HEY_INBOX_AUTOWRITE;
  delete process.env.MAW_SENDER;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
});

afterEach(() => {
  mockActive = false;
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
  delete process.env.MAW_HEY_INBOX_AUTOWRITE;
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = origTestMode;
  if (origMawSender === undefined) delete process.env.MAW_SENDER;
  else process.env.MAW_SENDER = origMawSender;
  if (origSshClient === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = origSshClient;
  if (origSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = origSshConnection;
  if (origSshTty === undefined) delete process.env.SSH_TTY;
  else process.env.SSH_TTY = origSshTty;
});

afterAll(() => {
  mockActive = false;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  console.warn = origWarn;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend — delivery branch coverage", () => {
  test("caller-supplied currentSession scopes target resolution", async () => {
    captureResponses = ["accepted"];

    await runCmd(() => cmdSend("codex-1", "hello", false, { currentSession: "89-mawjs", receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(resolveTargetArgCalls[0]?.[0]).toBe("codex-1");
    expect(resolveTargetArgCalls[0]?.[3]).toBe("89-mawjs");
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
  });

  test("local delivery signs, sends, logs, hooks, captures last line, and emits feed", async () => {
    captureResponses = ["accepted"];
    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:session:oracle", message: "[test-node:sender] hello" } }]);
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:session:oracle", message: "[test-node:sender] hello", route: "local" }]);
    expect(captureCalls.map(c => c.lines)).toEqual([3]);
    expect(emitFeedCalls[0].data.route).toBe("local");
    expect(transportEventCalls).toHaveLength(1);
    expect(transportEventCalls[0]).toMatchObject({
      eventName: "transport:after_send",
      payload: {
        event: "transport:after_send",
        route: "local",
        to: "local:session:oracle",
        from: "test-node:sender",
        via: "tmux",
        message: "[test-node:sender] hello",
        result: {
          ok: true,
          state: "local",
          route: "local",
        },
      },
    });
    expect(logs.join("\n")).toContain("delivered");
    expect(logs.join("\n")).toContain("accepted");
  });

  test("explicit --from stamps visible message and feed as the relay sender", async () => {
    captureResponses = ["accepted"];
    await runCmd(() => cmdSend("local:session:oracle", "hello", false, { from: "alpha:volt-oracle" }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[alpha:volt-oracle] hello" }]);
    expect(logMessageCalls).toEqual([{ from: "volt-oracle", to: "local:session:oracle", message: "[alpha:volt-oracle] hello", route: "local" }]);
    expect(emitFeedCalls[0].data.from).toBe("alpha:volt-oracle");
  });

  test("SSH relay without --from or MAW_SENDER refuses local impersonation", async () => {
    process.env.SSH_CONNECTION = "10.20.0.7 12345 10.20.0.5 22";

    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(sendKeysCalls).toEqual([]);
    expect(errs.join("\n")).toContain("SSH-relayed");
    expect(errs.join("\n")).toContain("--from alpha:volt-oracle");
  });

  test("MAW_SENDER allows SSH relay wrappers and signs as remote sender", async () => {
    process.env.SSH_CLIENT = "10.20.0.7 12345 22";
    process.env.MAW_SENDER = "alpha:volt-oracle";

    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[alpha:volt-oracle] hello" }]);
  });

  test("local delivery mirrors delivered hey messages into the receiver inbox when enabled", async () => {
    const inboxCalls: any[] = [];

    await runCmd(() => cmdSend("local:session:oracle", "hello", false, {
      receiverInbox: (input) => {
        inboxCalls.push(input);
        return {
          ok: true,
          oracle: "oracle",
          inboxDir: "/repo/ψ/inbox",
          path: "/repo/ψ/inbox/msg.md",
          filename: "msg.md",
        };
      },
    }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
    expect(inboxCalls).toEqual([{
      query: "local:session:oracle",
      target: "session:oracle.0",
      to: "local:session:oracle",
      from: "test-node:sender",
      message: "[test-node:sender] hello",
      config,
    }]);
  });

  test("local delivery sends to non-agent panes by default", async () => {
    getPaneCommandReturn = "zsh";
    captureResponses = ["post-send"];
    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
    expect(errs.join("\n")).not.toContain("no active Claude session");
  });

  test("--inbox queues to receiver inbox without pane injection", async () => {
    getPaneCommandReturn = "zsh";

    await runCmd(() => cmdSend("local:session:oracle", "offline task", false, {
      inboxOnly: true,
      receiverInbox: () => ({
        ok: true,
        oracle: "oracle",
        inboxDir: "/repo/ψ/inbox",
        path: "/repo/ψ/inbox/msg.md",
        filename: "msg.md",
      }),
    }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([]);
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:session:oracle", message: "[test-node:sender] offline task", route: "inbox" }]);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "inbox", state: "queued" });
    expect(logs.join("\n")).toContain("queued");
    expect(logs.join("\n")).toContain("ψ/inbox/msg.md");
  });

  test("--inbox receiver inbox writer failures surface as queue-only errors", async () => {
    getPaneCommandReturn = "zsh";

    await runCmd(() => cmdSend("local:session:oracle", "offline task", false, {
      inboxOnly: true,
      receiverInbox: () => {
        throw new Error("inbox locked");
      },
    }));

    expect(exitCode).toBe(1);
    expect(sendKeysCalls).toEqual([]);
    expect(logMessageCalls).toEqual([]);
    expect(errs.join("\n")).toContain("--inbox requested");
    expect(errs.join("\n")).toContain("inbox locked");
  });

  test("--force bypasses pane command and idle checks", async () => {
    getPaneCommandReturn = "zsh";
    captureResponses = ["post-send"];

    await runCmd(() => cmdSend("local:session:oracle", "forced", true));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] forced" }]);
    expect(captureCalls.map(c => c.lines)).toEqual([3]);
  });

  test("default delivery does not idle-guard busy panes", async () => {
    captureResponses = ["❯ git status", "❯ maw hey someone hi"];

    await runCmd(() => cmdSend("local:session:oracle", "blocked"));

    expect(exitCode).toBeUndefined();
    expect(sleepCalls).not.toContain(500);
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] blocked" }]);
    expect(errs.join("\n")).not.toContain("not idle");
  });

  test("--inbox queues to receiver inbox when the pane is busy", async () => {
    captureResponses = ["❯ draft one", "❯ draft two"];

    await runCmd(() => cmdSend("local:session:oracle", "queued while busy", false, {
      inboxOnly: true,
      receiverInbox: () => ({
        ok: true,
        oracle: "oracle",
        inboxDir: "/repo/ψ/inbox",
        path: "/repo/ψ/inbox/busy.md",
        filename: "busy.md",
      }),
    }));

    expect(exitCode).toBeUndefined();
    expect(sleepCalls).not.toContain(500);
    expect(sendKeysCalls).toEqual([]);
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:session:oracle", message: "[test-node:sender] queued while busy", route: "inbox" }]);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "inbox", state: "queued", lastLine: "--inbox requested; pane injection skipped" });
    expect(logs.join("\n")).toContain("busy.md");
  });

  test("peer delivery marks accepted-only responses queued until delivery is proven", async () => {
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "remote-session:oracle.0", lastLine: "remote ack" } });

    await runCmd(() => cmdSend("remote:session:oracle", "ping"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(curlFetchCalls[0].options.from).toBe("auto");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "oracle", text: "[test-node:sender] ping" });
    expect(logMessageCalls[0].route).toBe("peer:remote");
    expect(emitFeedCalls[0].data.route).toBe("peer");
    expect(emitFeedCalls[0].data.state).toBe("queued");
    expect(transportEventCalls).toHaveLength(1);
    expect(transportEventCalls[0]).toMatchObject({
      eventName: "transport:after_send",
      payload: {
        event: "transport:after_send",
        route: "peer",
        node: "remote",
        target: "oracle",
        peerUrl: "http://remote:3456",
        to: "remote:session:oracle",
        from: "test-node:sender",
        via: "http",
        message: "[test-node:sender] ping",
        result: {
          ok: false,
          state: "queued",
          target: "remote-session:oracle.0",
          peerUrl: "http://remote:3456",
          lastLine: "remote ack",
        },
      },
    });
    expect(logs.join("\n")).toContain("queued");
    expect(logs.join("\n")).not.toContain("delivered");
    expect(runHookCalls[0].name).toBe("after_send");
  });

  test("peer delivery uses explicit sender override for message body and v3 from-signing", async () => {
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };

    await runCmd(() => cmdSend("remote:session:oracle", "ping", false, { from: "alpha:volt-oracle" }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls[0].options.from).toBe("volt-oracle:alpha");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "oracle", text: "[alpha:volt-oracle] ping" });
    expect(emitFeedCalls[0].data.from).toBe("alpha:volt-oracle");
  });

  test("peer delivery failures emit a failed lifecycle event and exit", async () => {
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: false, status: 503, data: { error: "down" } });

    await runCmd(() => cmdSend("remote:session:oracle", "ping"));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data.route).toBe("peer");
    expect(emitFeedCalls[0].data.state).toBe("failed");
    expect(emitFeedCalls[0].data.error).toBe("down");
    expect(errs.join("\n")).toContain("Remote fetch failed");
  });

  test("discovery fallback marks accepted-only peer responses queued until delivery is proven", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "found:0", lastLine: "found ack" } });

    await runCmd(() => cmdSend("path/target", "hello"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls[0].url).toBe("http://discovered:3456/api/send");
    expect(logMessageCalls[0].route).toBe("discovery");
    expect(emitFeedCalls[0].data.route).toBe("discovery");
    expect(emitFeedCalls[0].data.state).toBe("queued");
    expect(transportEventCalls).toHaveLength(1);
    expect(transportEventCalls[0]).toMatchObject({
      eventName: "transport:after_send",
      payload: {
        event: "transport:after_send",
        route: "discovery",
        node: "path/target",
        target: "found:0",
        peerUrl: "http://discovered:3456",
        to: "path/target",
        from: "test-node:sender",
        via: "discovery",
        message: "[test-node:sender] hello",
        result: {
          ok: false,
          state: "queued",
          target: "found:0",
          peerUrl: "http://discovered:3456",
          lastLine: "found ack",
        },
      },
    });
    expect(logs.join("\n")).toContain("queued");
    expect(logs.join("\n")).not.toContain("delivered");
  });

  test("discovery fallback failures surface network error instead of local miss", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: false, status: 502, data: {} });

    await runCmd(() => cmdSend("path/target", "hello"));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data.route).toBe("discovery");
    expect(emitFeedCalls[0].data.error).toBe("HTTP 502");
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://discovered:3456");
  });

  test("resolver error prints detail and hint", async () => {
    resolveTargetReturn = { type: "error", detail: "window missing", hint: "run maw ls" };

    await runCmd(() => cmdSend("local:missing:oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window missing");
    expect(errs.join("\n")).toContain("run maw ls");
  });

  test("plain miss lists configured agents when available", async () => {
    config.agents = { alpha: "http://alpha" };
    resolveTargetReturn = null;

    await runCmd(() => cmdSend("path/unknown", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window not found");
    expect(errs.join("\n")).toContain("known agents: alpha");
  });
});

describe("cmdSend — prefix routers", () => {
  test("plugin route returns plugin output on success", async () => {
    plugins = [{ manifest: { name: "echo" } }];
    invokePluginResult = { ok: true, output: "echoed" };

    await runCmd(() => cmdSend("plugin:echo", "hello"));

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("echoed");
    expect(sendKeysCalls).toEqual([]);
  });

  test("plugin route exits when plugin is missing or returns an error", async () => {
    await runCmd(() => cmdSend("plugin:missing", "hello"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin not found: missing");

    plugins = [{ manifest: { name: "bad" } }];
    invokePluginResult = { ok: false, error: "boom" };
    await runCmd(() => cmdSend("plugin:bad", "hello"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin error: boom");
  });

  test("empty team target exits with usage before loading members", async () => {
    await runCmd(() => cmdSend("team:", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("usage: maw hey team:<team-name> <message>");
  });

  test("team with only sender explains invite guidance", async () => {
    oracleMembers = [];
    oracleRegistry = { members: ["sender"] };

    await runCmd(() => cmdSend("team:solo", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("has only the sender");
    expect(errs.join("\n")).toContain("invite more members");
  });

  test("empty team registry explains how to invite members", async () => {
    oracleMembers = [];
    oracleRegistry = null;

    await runCmd(() => cmdSend("team:missing", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no oracle members in team 'missing'");
    expect(errs.join("\n")).toContain("maw team oracle-invite");
  });

  test("team fan-out prefers brought workspace windows over oracle home sessions", async () => {
    oracleMembers = ["digger-oracle", "discord-oracle"];
    oracleRegistry = { members: ["digger-oracle", "discord-oracle", "sender"] };
    listSessionsReturn = [
      { name: "anon", windows: [
        { index: 0, name: "lead", active: true },
        { index: 1, name: "digger", active: false },
        { index: 2, name: "discord", active: false },
      ] },
      { name: "33-digger", windows: [{ index: 0, name: "digger-oracle", active: true }] },
      { name: "23-discord", windows: [{ index: 0, name: "discord-oracle", active: true }] },
    ];
    resolveTargetHandler = (query) => {
      if (query === "anon:digger") return { type: "local", target: "anon:1" };
      if (query === "anon:discord") return { type: "local", target: "anon:2" };
      return { type: "local", target: `HOME:${query}` };
    };

    await runCmd(() => cmdSend("team:anon", "hello"));

    expect(exitCode).toBeUndefined();
    expect(resolveTargetCalls).toEqual(["anon:digger", "anon:discord"]);
    expect(sendKeysCalls).toEqual([
      { target: "anon:1", text: "[test-node:sender] hello" },
      { target: "anon:2", text: "[test-node:sender] hello" },
    ]);
    expect(logs.join("\n")).toContain("fan-out complete: 2 delivered, 0 failed");
  });

  test("team fan-out keeps iterating when one member send throws", async () => {
    oracleMembers = ["ok-oracle", "bad-oracle"];
    oracleRegistry = { members: ["ok-oracle", "bad-oracle"] };
    resolveTargetHandler = (query) => {
      if (query === "bad-oracle") throw new Error("boom");
      return { type: "local", target: `session:${query}.0` };
    };

    await runCmd(() => cmdSend("team:squad", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:ok-oracle.0", text: "[test-node:sender] hello" }]);
    expect(errs.join("\n")).toContain("bad-oracle: boom");
    expect(logs.join("\n")).toContain("fan-out to 2 oracle(s) in team 'squad':");
    expect(logs.join("\n")).toContain("fan-out complete: 1 delivered, 1 failed");
  });
});

describe("cmdSend — bare-name, wake, and safety gates", () => {
  test("bare local target accepts same-node resolver hits", async () => {
    listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };

    await runCmd(() => cmdSend("oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
  });

  test("bare target rejects remote-only resolver hits before network delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };

    await runCmd(() => cmdSend("oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls).toEqual([]);
    expect(errs.join("\n")).toContain("not found locally");
  }, COMM_SEND_LOCATE_TIMEOUT_MS);



  test("bare located repo with no live session queues inbox-only with clear warning (#2056)", async () => {
    const receiverWrites: any[] = [];
    listSessionsReturn = [];
    resolveTargetReturn = { type: "peer", target: "renamed", node: "remote", peerUrl: "http://remote:3456" };
    manifestEntries = [{ name: "renamed", localPath: "/tmp/renamed-oracle", node: "test-node", sources: ["oracles.json"] }];

    await runCmd(() => cmdSend("renamed", "hello", false, {
      receiverInbox: async (input: any) => {
        receiverWrites.push(input);
        return { ok: true, oracle: "renamed", inboxDir: "/tmp/renamed-oracle/ψ/inbox", path: "/tmp/renamed-oracle/ψ/inbox/msg.md", filename: "msg.md" };
      },
    }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls).toEqual([]);
    expect(receiverWrites).toHaveLength(1);
    expect(receiverWrites[0].target).toBe("/tmp/renamed-oracle");
    expect(logs.join("\n")).toContain("renamed found at /tmp/renamed-oracle but no active session — written to inbox only");
    expect(warns.join("\n")).toContain("⚠ target node offline — message written to inbox only, will not be seen until node wakes");
  }, COMM_SEND_LOCATE_TIMEOUT_MS);

  test("bare located repo resolves to active local session by cwd before inbox fallback (#2056)", async () => {
    listSessionsReturn = [{ name: "77-renamed", windows: [{ index: 0, name: "renamed-oracle", active: true, cwd: "/tmp/renamed-oracle" } as any] }];
    resolveTargetReturn = { type: "peer", target: "renamed", node: "remote", peerUrl: "http://remote:3456" };
    manifestEntries = [{ name: "renamed", localPath: "/tmp/renamed-oracle", node: "test-node", sources: ["oracles.json"] }];

    await runCmd(() => cmdSend("renamed", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls).toEqual([]);
    expect(sendKeysCalls).toEqual([{ target: "77-renamed:renamed-oracle", text: "[test-node:sender] hello" }]);
  }, COMM_SEND_LOCATE_TIMEOUT_MS);

  test("bare manifest cross-node hit does not silently route to peer (#2056)", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    listSessionsReturn = [];
    resolveTargetReturn = { type: "peer", target: "renamed", node: "remote", peerUrl: "http://remote:3456" };
    manifestEntries = [{ name: "renamed", localPath: "/tmp/renamed-oracle", node: "remote", sources: ["oracles.json"] }];

    await runCmd(() => cmdSend("renamed", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls).toEqual([]);
    expect(warns.join("\n")).toContain("renamed found at /tmp/renamed-oracle but no active session — written to inbox only");
    expect(errs.join("\n")).toContain("found but no active session");
  }, COMM_SEND_LOCATE_TIMEOUT_MS);

  test("bare peer aliases are allowed as explicit federation targets (#1940)", async () => {
    config.namedPeers = [{
      name: "world-mawjs",
      url: "http://oracle-world.wg:3462",
      node: "oracle-world",
      identity: { oracle: "mawjs", node: "oracle-world" },
    }];
    resolveTargetReturn = { type: "peer", target: "mawjs", node: "oracle-world", peerUrl: "http://oracle-world.wg:3462" };
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, delivered: true, target: "mawjs" } });

    await runCmd(() => cmdSend("world-mawjs", "hello"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map((c) => c.url)).toEqual(["http://oracle-world.wg:3462/api/send"]);
    expect(JSON.parse(curlFetchCalls[0].options.body)).toMatchObject({ target: "mawjs" });
  });

  test("bare target rejects ambiguous local candidates with candidate list", async () => {
    resolveTargetError = new _rFindWindow.AmbiguousMatchError("oracle", ["47-mawjs:oracle", "54-mawjs:oracle"]);

    await runCmd(() => cmdSend("oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("ambiguous");
    expect(errs.join("\n")).toContain("47-mawjs:oracle");
  });

  test("bare target ambiguity falls back to the query when no candidates are attached", async () => {
    resolveTargetError = new _rFindWindow.AmbiguousMatchError("oracle", []);

    await runCmd(() => cmdSend("oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("matches 1 local windows");
    expect(errs.join("\n")).toContain("maw hey oracle");
  });

  test("local short-form hey auto-wakes fleet-known targets before resolving", async () => {
    listSessionsReturn = [];
    findOracleResult = { name: "volt", sources: ["fleet"], isLive: false };
    resolveTargetReturn = { type: "local", target: "volt-session:volt-oracle.0" };

    await runCmd(() => cmdSend("test-node:volt", "hello"));

    expect(exitCode).toBeUndefined();
    expect(cmdWakeCalls).toEqual([{ oracle: "volt", opts: {} }]);
    expect(logs.join("\n")).toContain("auto-wake");
    expect(sendKeysCalls[0].target).toBe("volt-session:volt-oracle.0");
  });

  test("cross-node short-form hey calls remote wake before send", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = (url) => {
      if (url.endsWith("/api/wake")) return { ok: true, status: 200, data: { ok: true } };
      return { ok: true, status: 200, data: { ok: true, target: "oracle.0" } };
    };

    await runCmd(() => cmdSend("remote:oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map(c => c.url)).toEqual(["http://remote:3456/api/wake", "http://remote:3456/api/send"]);
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "oracle" });
  });

  test("cross-node explicit oracle session sends directly without remote wake", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "volt-oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "05-volt:1" } });

    await runCmd(() => cmdSend("remote:volt-oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map(c => c.url)).toEqual(["http://remote:3456/api/send"]);
    expect(JSON.parse(curlFetchCalls[0].options.body)).toMatchObject({ target: "volt-oracle" });
  });

  test("cross-node explicit session window suffix sends directly with suffix preserved", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "volt-oracle:1", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "05-volt:1" } });

    await runCmd(() => cmdSend("remote:volt-oracle:1", "hello"));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map(c => c.url)).toEqual(["http://remote:3456/api/send"]);
    expect(JSON.parse(curlFetchCalls[0].options.body)).toMatchObject({ target: "volt-oracle:1" });
  });

  test("#1998: cross-node wake failure warns but still attempts send (live non-wakeable target)", async () => {
    // Repro: target is a live window/pane that isn't a wakeable oracle (repo),
    // so remote /api/wake returns "missing oracle name" — but /api/send to the
    // same target succeeds via the receiver's lenient pane resolution.
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = (url) => {
      if (url.endsWith("/api/wake")) return { ok: false, status: 200, data: { ok: false, error: "missing oracle name" } };
      return { ok: true, status: 200, data: { ok: true, target: "oracle.0", state: "delivered" } };
    };

    await runCmd(() => cmdSend("remote:oracle", "hello"));

    // No hard exit — send was attempted and succeeded.
    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls.map(c => c.url)).toEqual(["http://remote:3456/api/wake", "http://remote:3456/api/send"]);
    // Wake failure is surfaced as a non-fatal warning, not a fatal error.
    expect(warns.join("\n")).toContain("cross-node wake skipped");
  });

  test("#1998: when wake fails AND send fails, the send error surfaces and exits", async () => {
    // Genuinely unreachable peer: wake fails, then send also fails → clean exit
    // with the send-path "Remote fetch failed" error (#411 contract preserved).
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = (url) => {
      if (url.endsWith("/api/wake")) return { ok: false, status: 0, data: undefined };
      return { ok: false, status: 0, data: undefined };
    };

    await runCmd(() => cmdSend("remote:oracle", "hello"));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls.map(c => c.url)).toEqual(["http://remote:3456/api/wake", "http://remote:3456/api/send"]);
    expect(errs.join("\n")).toContain("Remote fetch failed for peer");
  });

  test("ACL queue stores pending peer sends instead of delivering", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopes = [{ name: "default" }];
    aclDecision = "queue";

    await runCmd(() => cmdSend("remote:session:receiver", "needs approval"));

    expect(exitCode).toBeUndefined();
    expect(savePendingCalls).toEqual([{ sender: "sender", target: "receiver", message: "needs approval", query: "remote:session:receiver" }]);
    expect(curlFetchCalls).toEqual([]);
    expect(logs.join("\n")).toContain("queued for approval");
  });

  test("ACL evaluation errors warn and allow peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    aclError = new Error("acl unreadable");

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("ACL evaluation failed (acl unreadable); allowing send");
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
  });

  test("--approve --trust records trust before peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0" } });

    await runCmd(() => cmdSend("remote:session:receiver", "approved", false, { approve: true, trust: true }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([{ sender: "sender", target: "receiver" }]);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(logs.join("\n")).toContain("trusted sender");
  });

  test("trust persistence warnings do not block approved peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    trustAddError = new Error("disk full");
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0" } });

    await runCmd(() => cmdSend("remote:session:receiver", "approved", false, { approve: true, trust: true }));

    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("trust persistence failed");
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
  });

  test("consent gate can stop peer sends with its own exit code", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    process.env.MAW_CONSENT = "1";
    consentDecision = { allow: false, message: "consent required", exitCode: 42 };

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBe(42);
    expect(curlFetchCalls).toEqual([]);
    expect(errs.join("\n")).toContain("consent required");
  });

  test("consent gate denial without details uses the default failure exit", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    process.env.MAW_CONSENT = "1";
    consentDecision = { allow: false };

    await runCmd(() => cmdSend("remote:session:receiver", "hello"));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls).toEqual([]);
    expect(errs).toEqual([]);
  });
});
