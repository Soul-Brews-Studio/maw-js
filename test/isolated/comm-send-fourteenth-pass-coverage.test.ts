/**
 * Fourteenth-pass isolated coverage for src/commands/shared/comm-send.ts.
 *
 * Targets the last uncovered local-only/busy-pane branches without touching
 * live tmux, network, filesystem inboxes, hooks, or process state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

let config: any;
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let captureResponses: string[];
let getPaneCommandReturn: string;
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let runHookCalls: Array<{ name: string; payload: any }>;
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
  listSessions: async () => listSessionsReturn,
  capture: async () => captureResponses.shift() ?? "",
  sendKeys: async (target: string, text: string) => {
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => getPaneCommandReturn,
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
  findPeerForTarget: async () => null,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return { ok: true, status: 200, data: { ok: true } };
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
  logMessage: () => {},
  emitFeed: () => {},
}));

mock.module(join(srcRoot, "src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async (input: any) => {
    defaultInboxCalls.push(input);
    return null;
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
  captureResponses = ["❯ "];
  getPaneCommandReturn = "claude";
  sendKeysCalls = [];
  curlFetchCalls = [];
  runHookCalls = [];
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

describe("comm-send fourteenth-pass uncovered branches", () => {
  test("bare targets that resolve to peers are rejected as local-only before network send", async () => {
    resolveTargetReturn = {
      type: "peer",
      target: "remote-oracle",
      node: "remote",
      peerUrl: "http://remote:3456",
    };

    await runCmd(() => cmdSend("remote-oracle", "do not route implicitly", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("bare target 'remote-oracle' not found locally");
    expect(errs.join("\n")).toContain("bare names are local-only");
    expect(curlFetchCalls).toEqual([]);
    expect(sendKeysCalls).toEqual([]);
  });

  test("persistently busy local panes deliver by default without the old force hint", async () => {
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    captureResponses = ["❯ drafting a reply", "❯ still typing"];

    await runCmd(() => cmdSend("local:session:oracle", "wait for idle", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(sleepCalls).toEqual([150]);
    expect(defaultInboxCalls).toEqual([]);
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] wait for idle" }]);
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:session:oracle", message: "[test-node:sender] wait for idle" } }]);
    expect(errs.join("\n")).not.toContain("not idle");
  });
});
