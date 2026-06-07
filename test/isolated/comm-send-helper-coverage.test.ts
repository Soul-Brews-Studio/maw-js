/**
 * Extra isolated helper/runtime coverage for src/commands/shared/comm-send.ts.
 *
 * Focus:
 * - helper branches that are awkward to hit through the large integration-ish suites
 * - discovery fallback + explicit miss branches
 * - receiver-inbox queue branch for non-agent local panes
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
let captureResponses: Array<string | Error>;
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchReturn: { ok: boolean; status?: number; data?: any };
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let defaultInboxCalls: ReceiverInboxInput[];
let defaultInboxResult: ReceiverInboxResult | null;
let childExecValue = "08-mawjs\n";
let childExecThrows = false;

mock.module("child_process", () => ({
  execSync: () => {
    if (childExecThrows) throw new Error("tmux missing");
    return childExecValue;
  },
}));

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return "0 claude\n"; }
    async tryRun() { return "0 claude\n"; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
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
  loadAllScopes: () => [],
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

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

const {
  checkPaneIdle,
  cmdSend,
  formatSignedMessage,
  resolveMyName,
  resolveOraclePane,
  resolveTeamWorkspaceMemberTarget,
} = await import("../../src/commands/shared/comm-send");

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
  config = { node: "test-node", oracle: "sender", host: "localhost", port: 3456, namedPeers: [] };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = null;
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = [];
  sendKeysCalls = [];
  curlFetchCalls = [];
  curlFetchReturn = { ok: true, status: 200, data: { ok: true, target: "receiver", lastLine: "ok", state: "delivered" } };
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  defaultInboxCalls = [];
  defaultInboxResult = null;
  childExecValue = "08-mawjs\n";
  childExecThrows = false;
  process.env.CLAUDE_AGENT_NAME = "sender";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
});

describe("comm-send helpers", () => {
  test("resolveOraclePane honors pane-specific targets and chooses the lowest agent pane", async () => {
    await expect(resolveOraclePane("s:w.3")).resolves.toBe("s:w.3");

    const chosen = await resolveOraclePane("s:w", {
      tmuxRun: async () => "junk\n2 zsh\n1 codex\n0 node\n",
      isAgentCommandFn: (cmd: string | null | undefined) => ["node", "codex"].includes((cmd ?? "").trim()),
    });
    expect(chosen).toBe("s:w.0");
  });

  test("resolveOraclePane falls back on single-pane, no-agent, and tmux errors", async () => {
    await expect(resolveOraclePane("solo", { tmuxRun: async () => "0 claude\n" })).resolves.toBe("solo");
    await expect(resolveOraclePane("none", { tmuxRun: async () => "0 zsh\n1 bash\n" })).resolves.toBe("none");
    await expect(resolveOraclePane("err", { tmuxRun: async () => { throw new Error("boom"); } })).resolves.toBe("err");
  });

  test("resolveMyName prefers the explicit environment override", () => {
    process.env.CLAUDE_AGENT_NAME = "agent-env";
    expect(resolveMyName({ node: "cfg-node" } as any)).toBe("agent-env");
  });

  test("formatSignedMessage preserves commands/signatures and signs plain text with fallback node", () => {
    expect(formatSignedMessage("   ", { node: "x" } as any, "sender")).toBe("   ");
    expect(formatSignedMessage("  /wake", { node: "x" } as any, "sender")).toBe("  /wake");
    expect(formatSignedMessage("$skill", { node: "x" } as any, "sender")).toBe("$skill");
    expect(formatSignedMessage("[node:oracle] hi", { node: "x" } as any, "sender")).toBe("[node:oracle] hi");
    expect(formatSignedMessage("  hello", {} as any, "sender")).toBe("  [local:sender] hello");
  });

  test("checkPaneIdle strips ANSI, reports active input, and treats errors as idle", async () => {
    await expect(checkPaneIdle("pane", undefined, { captureFn: async () => "\u001b[32m❯ \u001b[0m" })).resolves.toEqual({ idle: true, lastInput: "" });
    await expect(checkPaneIdle("pane", undefined, { captureFn: async () => "$ drafting reply" })).resolves.toEqual({ idle: false, lastInput: "drafting reply" });
    await expect(checkPaneIdle("pane", undefined, { captureFn: async () => "agent is running" })).resolves.toEqual({ idle: true, lastInput: "" });
    await expect(checkPaneIdle("pane", undefined, { captureFn: async () => { throw new Error("no capture"); } })).resolves.toEqual({ idle: true, lastInput: "" });
  });

  test("resolveTeamWorkspaceMemberTarget matches raw, stripped, and -oracle variants", () => {
    const sessions = [{
      name: "alpha",
      windows: [
        { name: "volt" },
        { name: "odin-oracle" },
      ],
    }] as any;

    expect(resolveTeamWorkspaceMemberTarget("alpha", "volt-oracle", sessions)).toBe("alpha:volt");
    expect(resolveTeamWorkspaceMemberTarget("alpha", "odin", sessions)).toBe("alpha:odin-oracle");
    expect(resolveTeamWorkspaceMemberTarget("missing", "odin", sessions)).toBeNull();
  });
});

describe("cmdSend fallback/runtime branches", () => {
  test("--inbox queues to receiver inbox without local pane injection", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    getPaneCommandReturn = "zsh";
    defaultInboxResult = {
      ok: true,
      oracle: "receiver",
      inboxDir: "/tmp/inbox",
      path: "/tmp/inbox/msg.md",
      filename: "msg.md",
    };

    await runCmd(() => cmdSend("local:oracle", "queued local", false, { inboxOnly: true }));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([]);
    expect(defaultInboxCalls[0]).toMatchObject({ target: "session:oracle.0", message: "[test-node:sender] queued local" });
    expect(logMessageCalls[0]).toMatchObject({ route: "inbox", to: "local:oracle" });
    expect(logs.join("\n")).toContain("--inbox requested; pane injection skipped");
  });

  test("discovery fallback delivers successfully and runs after_send", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchReturn = { ok: true, status: 200, data: { ok: true, target: "ghost.0", lastLine: "caught up", state: "delivered" } };

    await runCmd(() => cmdSend("local:ghost", "discover me", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(curlFetchCalls[0].url).toBe("http://discovered:3456/api/send");
    expect(logMessageCalls[0]).toMatchObject({ route: "discovery", to: "local:ghost" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "delivered", peerUrl: "http://discovered:3456" });
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:ghost", message: "[test-node:sender] discover me" } }]);
    expect(logs.join("\n")).toContain("caught up");
  });

  test("discovery fallback surfaces remote failures without falling through to a local miss", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchReturn = { ok: false, status: 503, data: { error: "unreachable" } };

    await runCmd(() => cmdSend("local:ghost", "discover me", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://discovered:3456");
    expect(errs.join("\n")).not.toContain("window not found");
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "failed", error: "unreachable" });
  });

  test("resolver error prints its detail and hint when inbox queueing is disabled", async () => {
    resolveTargetReturn = { type: "error", detail: "no route", hint: "run maw ls -v" };

    await runCmd(() => cmdSend("local:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("error");
    expect(errs.join("\n")).toContain("no route");
    expect(errs.join("\n")).toContain("run maw ls -v");
  });

  test("generic miss prints known agents when resolver returned null and no peer was found", async () => {
    resolveTargetReturn = null;
    config.agents = { alpha: "local:alpha", beta: "mba:beta" };

    await runCmd(() => cmdSend("local:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window not found: local:ghost");
    expect(errs.join("\n")).toContain("known agents: alpha, beta");
  });
});
