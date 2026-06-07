/**
 * Focused TEST-ONLY branch coverage for src/commands/shared/comm-send.ts.
 *
 * Targets small executable branches that are distinct from the existing
 * comm-send suites: live local auto-wake skip, unknown peer short-form wake
 * skip, no-scope ACL default allow, non-peer trust no-op, and team workspace
 * suffix normalization edge cases.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

let config: any;
let listSessionsReturn: any[];
let listSessionsCalls: number;
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let captureResponses: string[];
let sendKeysCalls: Array<{ target: string; text: string }>;
let getPaneCommandCalls: string[];
let curlFetchCalls: Array<{ url: string; options: any }>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let findOracleResult: any;
let shouldAutoWakeCalls: Array<{ target: string; input: any }>;
let shouldAutoWakeReturn: { wake: boolean };
let cmdWakeCalls: Array<{ oracle: string; opts: any }>;
let scopes: any[];
let loadScopesCalls: number;
let aclCalls: Array<{ sender: string; target: string }>;
let trustAddCalls: Array<{ sender: string; target: string }>;
let defaultInboxCalls: any[];
let sleepCalls: number[];

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return listSessionsReturn;
  },
  capture: async () => captureResponses.shift() ?? "",
  sendKeys: async (target: string, text: string) => {
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async (target: string) => {
    getPaneCommandCalls.push(target);
    return "claude";
  },
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
  findPeerForTarget: async () => findPeerUrl,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return { ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack" } };
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
  defaultReceiverInboxWriter: () => async (input: any) => {
    defaultInboxCalls.push(input);
    return null;
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  findOracle: () => findOracleResult,
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: (target: string, input: any) => {
    shouldAutoWakeCalls.push({ target, input });
    return shouldAutoWakeReturn;
  },
}));

mock.module(join(srcRoot, "src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (oracle: string, opts: any) => {
    cmdWakeCalls.push({ oracle, opts });
  },
}));

mock.module(join(srcRoot, "src/commands/shared/scope-acl"), () => ({
  loadAllScopes: () => {
    loadScopesCalls += 1;
    return scopes;
  },
  evaluateAclFromDisk: (sender: string, target: string) => {
    aclCalls.push({ sender, target });
    return "queue";
  },
}));

mock.module(join(srcRoot, "src/lib/trust-store"), () => ({
  cmdAdd: (sender: string, target: string) => {
    trustAddCalls.push({ sender, target });
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
  sleepCalls.push(ms);
};

const { cmdSend, resolveTeamWorkspaceMemberTarget } = await import("../src/commands/shared/comm-send");

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
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "live-oracle", active: true }] }];
  listSessionsCalls = 0;
  resolveTargetReturn = { type: "local", target: "session:live-oracle.0" };
  findPeerUrl = null;
  captureResponses = ["❯ ", "accepted"];
  sendKeysCalls = [];
  getPaneCommandCalls = [];
  curlFetchCalls = [];
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  findOracleResult = { name: "live", node: "test-node" };
  shouldAutoWakeCalls = [];
  shouldAutoWakeReturn = { wake: false };
  cmdWakeCalls = [];
  scopes = [];
  loadScopesCalls = 0;
  aclCalls = [];
  trustAddCalls = [];
  defaultInboxCalls = [];
  sleepCalls = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("comm-send focused remaining branch coverage", () => {
  test("local short-form live targets consult auto-wake with isLive true but skip waking", async () => {
    await runCmd(() => cmdSend("local:live", "already awake", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(shouldAutoWakeCalls).toHaveLength(1);
    expect(shouldAutoWakeCalls[0]).toMatchObject({
      target: "live",
      input: { site: "hey", isLive: true, isFleetKnown: false, isCanonicalTarget: false },
    });
    expect(shouldAutoWakeCalls[0].input.manifest).toMatchObject({ name: "live", isLive: true });
    expect(cmdWakeCalls).toEqual([]);
    expect(listSessionsCalls).toBe(1);
    expect(sendKeysCalls).toEqual([{ target: "session:live-oracle.0", text: "[test-node:sender] already awake" }]);
  });

  test("unknown cross-node short-form peers skip remote wake and fall through to resolver errors", async () => {
    config.namedPeers = [];
    resolveTargetReturn = { type: "error", detail: "unknown peer remote", hint: "configure namedPeers" };

    await runCmd(() => cmdSend("remote:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(shouldAutoWakeCalls).toEqual([]);
    expect(curlFetchCalls).toEqual([]);
    expect(errs.join("\n")).toContain("unknown peer remote");
    expect(errs.join("\n")).toContain("configure namedPeers");
  });

  test("peer sends default-allow when no ACL scopes exist even if evaluator would queue", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopes = [];

    await runCmd(() => cmdSend("remote:session:receiver", "no scopes", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(loadScopesCalls).toBe(1);
    expect(aclCalls).toEqual([]);
    expect(curlFetchCalls.map((call) => call.url)).toEqual(["http://remote:3456/api/send"]);
    expect(logMessageCalls[0]).toMatchObject({ route: "peer:remote", message: "[test-node:sender] no scopes" });
  });

  test("approve plus trust is a peer-only side effect and does not persist trust for local sends", async () => {
    resolveTargetReturn = { type: "local", target: "session:live-oracle.0" };

    await runCmd(() => cmdSend("local:session:live-oracle", "local approved", false, {
      approve: true,
      trust: true,
      receiverInbox: false,
    }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([]);
    expect(sendKeysCalls).toEqual([{ target: "session:live-oracle.0", text: "[test-node:sender] local approved" }]);
  });

  test("team workspace member resolution trims names and handles the empty stripped suffix branch", () => {
    const sessions = [{
      name: "team-a",
      windows: [
        { index: 0, name: "solo", active: false },
        { index: 1, name: "-oracle", active: false },
      ],
    }];

    expect(resolveTeamWorkspaceMemberTarget("team-a", "  solo-oracle  ", sessions as any)).toBe("team-a:solo");
    expect(resolveTeamWorkspaceMemberTarget("team-a", "-oracle", sessions as any)).toBe("team-a:-oracle");
    expect(resolveTeamWorkspaceMemberTarget("missing", "solo-oracle", sessions as any)).toBeNull();
  });
});
