import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

// Capture real implementations before mocking — gate pattern prevents mock
// bleed into later files that share this process (#2474).
const _rSdk = await import("../src/sdk");
const _rConfig = await import("../src/config");
const _rFeed = await import("../src/commands/shared/comm-log-feed");
const _rOracle = await import("../src/lib/oracle-manifest");
const _rAutoWake = await import("../src/commands/shared/should-auto-wake");

const realSdk = {
  listSessions: _rSdk.listSessions,
  capture: _rSdk.capture,
  sendKeys: _rSdk.sendKeys,
  isAgentCommand: _rSdk.isAgentCommand,
  findPeerForTarget: _rSdk.findPeerForTarget,
  resolveTarget: _rSdk.resolveTarget,
  curlFetch: _rSdk.curlFetch,
  runHook: _rSdk.runHook,
};
const realConfig = { loadConfig: _rConfig.loadConfig, cfgLimit: _rConfig.cfgLimit };
const realFeed = { logMessage: _rFeed.logMessage, emitFeed: _rFeed.emitFeed };
const realOracle = { findOracle: _rOracle.findOracle, loadManifestCached: _rOracle.loadManifestCached };
const realAutoWake = { shouldAutoWake: _rAutoWake.shouldAutoWake };

let mockActive = false;
let sendKeysShouldThrow = false;
let order: string[];
let logs: string[];
let errs: string[];
let exitCode: number | undefined;
let runHookCalls: unknown[];
let logMessageCalls: unknown[];
let emitFeedCalls: unknown[];

mock.module(join(srcRoot, "src/sdk"), () => ({
  ..._rSdk,
  listSessions: async () => mockActive ? [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }] : realSdk.listSessions(),
  capture: async (target: string, lines: number, host?: string) => mockActive ? "" : realSdk.capture(target, lines, host),
  sendKeys: async (target: string, text: string) => {
    if (!mockActive) return realSdk.sendKeys(target, text);
    order.push("sendKeys");
    if (sendKeysShouldThrow) throw new Error("pane vanished");
  },
  isAgentCommand: (cmd: string | null | undefined) => mockActive ? true : realSdk.isAgentCommand(cmd),
  findPeerForTarget: async (...args: Parameters<typeof realSdk.findPeerForTarget>) => mockActive ? null : realSdk.findPeerForTarget(...args),
  resolveTarget: (...args: Parameters<typeof realSdk.resolveTarget>) => mockActive ? ({ type: "local" as const, target: "session:oracle.0" }) : realSdk.resolveTarget(...args),
  curlFetch: async (...args: Parameters<typeof realSdk.curlFetch>) => mockActive ? ({ ok: true, data: { ok: true } }) : realSdk.curlFetch(...args),
  runHook: async (...args: unknown[]) => {
    if (!mockActive) return realSdk.runHook("" as any, {} as any);
    runHookCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  ..._rConfig,
  loadConfig: () => mockActive ? ({ node: "test-node", oracle: "sender", port: 3456, namedPeers: [], commands: { default: "claude" } }) : realConfig.loadConfig(),
  cfgLimit: (...args: Parameters<typeof realConfig.cfgLimit>) => mockActive ? 120 : realConfig.cfgLimit(...args),
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  ..._rFeed,
  logMessage: (...args: unknown[]) => {
    if (!mockActive) return realFeed.logMessage("" as any, "" as any, "" as any, "" as any);
    logMessageCalls.push(args);
  },
  emitFeed: (...args: unknown[]) => {
    if (!mockActive) return realFeed.emitFeed("" as any, "" as any, "" as any, "" as any, 0, {} as any);
    emitFeedCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  ..._rOracle,
  findOracle: (name: string) => mockActive ? ({ name: "oracle", node: "test-node" }) : realOracle.findOracle(name),
  loadManifestCached: () => mockActive ? [] : realOracle.loadManifestCached(),
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  ..._rAutoWake,
  shouldAutoWake: (...args: Parameters<typeof realAutoWake.shouldAutoWake>) => mockActive ? ({ wake: false }) : realAutoWake.shouldAutoWake(...args),
}));

const origExit = process.exit;
const origLog = console.log;
const origErr = console.error;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;

const { cmdSend } = await import("../src/commands/shared/comm-send");

async function runCmd() {
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await cmdSend("oracle", "hello", false, {
      noVerifySubmit: true,
      receiverInbox: async () => {
        order.push("receiverInbox");
        return { ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  } finally {
    console.log = origLog;
    console.error = origErr;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  process.env.CLAUDE_AGENT_NAME = "sender";
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  sendKeysShouldThrow = false;
  order = [];
  logs = [];
  errs = [];
  exitCode = undefined;
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
});

afterEach(() => {
  mockActive = false;
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origSshClient === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = origSshClient;
  if (origSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = origSshConnection;
  if (origSshTty === undefined) delete process.env.SSH_TTY;
  else process.env.SSH_TTY = origSshTty;
});

afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origErr;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("cmdSend durable receiver inbox (#1967)", () => {
  test("persists inbox before pane injection and queues when injection fails", async () => {
    sendKeysShouldThrow = true;

    await runCmd();

    expect(exitCode).toBeUndefined();
    expect(order).toEqual(["receiverInbox", "sendKeys"]);
    expect(logs.join("\n")).toContain("queued");
    expect(logs.join("\n")).toContain("tmux delivery failed: pane vanished");
    expect(errs).toEqual([]);
    expect(runHookCalls).toEqual([]);
    expect(logMessageCalls).toContainEqual(["sender", "oracle", "[test-node:sender] hello", "inbox"]);
    expect((emitFeedCalls[0] as any[])[5]).toMatchObject({
      state: "queued",
      route: "inbox",
      lastLine: "tmux delivery failed: pane vanished",
    });
  });
});
