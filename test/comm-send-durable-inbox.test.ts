import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

let sendKeysShouldThrow = false;
let order: string[];
let logs: string[];
let errs: string[];
let exitCode: number | undefined;
let runHookCalls: unknown[];
let logMessageCalls: unknown[];
let emitFeedCalls: unknown[];

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }],
  capture: async () => "",
  sendKeys: async () => {
    order.push("sendKeys");
    if (sendKeysShouldThrow) throw new Error("pane vanished");
  },
  isAgentCommand: () => true,
  findPeerForTarget: async () => null,
  resolveTarget: () => ({ type: "local", target: "session:oracle.0" }),
  curlFetch: async () => ({ ok: true, data: { ok: true } }),
  runHook: async (...args: unknown[]) => {
    runHookCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => ({ node: "test-node", oracle: "sender", port: 3456, namedPeers: [] }),
  cfgLimit: () => 120,
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  logMessage: (...args: unknown[]) => {
    logMessageCalls.push(args);
  },
  emitFeed: (...args: unknown[]) => {
    emitFeedCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  findOracle: () => ({ name: "oracle", node: "test-node" }),
  loadManifestCached: () => [],
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: false }),
}));

const origExit = process.exit;
const origLog = console.log;
const origErr = console.error;
const origAgentName = process.env.CLAUDE_AGENT_NAME;

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
  process.env.CLAUDE_AGENT_NAME = "sender";
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
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
});

afterAll(() => {
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
