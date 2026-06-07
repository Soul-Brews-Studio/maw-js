/**
 * Focused failure/forgiving-path coverage for src/commands/shared/comm-send.ts.
 *
 * Fully mocked: no live tmux, network, inbox, trust-store, or ACL side effects.
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

let config: any;
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchHandler: (url: string, options: any) => CurlResult | Promise<CurlResult>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let shouldWake: boolean;
let scopesThrow: Error | null;
let trustAddError: Error | null;
let trustAddCalls: Array<{ sender: string; target: string }>;

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
  capture: async () => "accepted",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
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
  defaultReceiverInboxWriter: () => async () => null,
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: shouldWake }),
}));

mock.module(join(srcRoot, "src/commands/shared/scope-acl"), () => ({
  loadAllScopes: () => {
    if (scopesThrow) throw scopesThrow;
    return [{ name: "prod" }];
  },
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
const origAclBypass = process.env.MAW_ACL_BYPASS;
const origConsent = process.env.MAW_CONSENT;

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
  resolveTargetReturn = null;
  findPeerUrl = null;
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack" } });
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  shouldWake = false;
  scopesThrow = null;
  trustAddError = null;
  trustAddCalls = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
  delete process.env.MAW_ACL_BYPASS;
  delete process.env.MAW_CONSENT;
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origAclBypass === undefined) delete process.env.MAW_ACL_BYPASS;
  else process.env.MAW_ACL_BYPASS = origAclBypass;
  if (origConsent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = origConsent;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend failure and forgiving branches", () => {
  test("cross-node auto-wake failure exits before peer send", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    shouldWake = true;
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: false, status: 503, data: { error: "wake offline" } });

    await runCmd(() => cmdSend("remote:oracle", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/wake");
    expect(JSON.parse(curlFetchCalls[0].options.body)).toEqual({ target: "oracle" });
    expect(errs.join("\n")).toContain("cross-node wake failed for oracle: wake offline");
    expect(runHookCalls).toEqual([]);
  });

  test("peer send failure emits failed lifecycle and exits with remote hint", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: false, status: 502, data: { error: "bad gateway" } });

    await runCmd(() => cmdSend("remote:session:receiver", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "failed", error: "bad gateway" });
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://remote:3456 (remote): bad gateway");
    expect(runHookCalls).toEqual([]);
  });

  test("discovery send failure reports network failure instead of local miss", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: false, status: 504, data: {} });

    await runCmd(() => cmdSend("local:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(curlFetchCalls[0].url).toBe("http://discovered:3456/api/send");
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "failed", error: "HTTP 504" });
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://discovered:3456: HTTP 504");
  });

  test("ACL evaluation errors warn and fall through to peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopesThrow = new Error("scope store corrupt");

    await runCmd(() => cmdSend("remote:session:receiver", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("warn: ACL evaluation failed (scope store corrupt); allowing send");
    expect(curlFetchCalls).toHaveLength(1);
    expect(logMessageCalls[0]).toMatchObject({ route: "peer:remote", message: "[test-node:sender] hello" });
  });

  test("trust persistence errors warn but approved peer send still delivers", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    trustAddError = new Error("trust disk read-only");

    await runCmd(() => cmdSend("remote:session:receiver", "approved", false, {
      approve: true,
      trust: true,
      receiverInbox: false,
    }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([]);
    expect(errs.join("\n")).toContain("warn: trust persistence failed (trust disk read-only)");
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "remote:session:receiver", message: "[test-node:sender] approved" } }]);
  });
});
