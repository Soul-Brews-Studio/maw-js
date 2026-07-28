import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import type { ReceiverInboxResult } from "../src/commands/shared/receiver-inbox";

const srcRoot = join(import.meta.dir, "..");

// Capture real implementations before mocking — gate pattern prevents mock
// bleed into later files that share this process (#2474).
//
// kobo-592: `await import(path)` returns the module's namespace object — a
// SINGLETON per resolved specifier, the SAME object every importer in this
// process gets. `mock.module(path, factory)` mutates that singleton's live
// bindings in place; it does not swap importers over to a distinct new
// object. So a bare `const _rSdk = await import(...)` is NOT a snapshot —
// it's a live reference that reflects whatever `mock.module` did to that
// path most recently, including calls made LATER in this very file (line 62
// below) or a restore attempted afterward. Verified live: without the
// spread-copy here, reading `_rConfig.cfgLimit` from `afterAll` (after this
// file's own `mock.module` call at line ~99) returned the MOCKED closure,
// not the real function — so restoring the module with `() => _rConfig` in
// afterAll just put the mock back in a new box. Spreading into a fresh plain
// object HERE, before any `mock.module` call in this file, decouples the
// capture from that singleton — a plain object's own properties can't be
// mutated by a later reassignment of a DIFFERENT object's bindings.
const _rSdk = { ...(await import("../src/sdk")) };
const _rConfig = { ...(await import("../src/config")) };
const _rFeed = { ...(await import("../src/commands/shared/comm-log-feed")) };
const _rOracle = { ...(await import("../src/lib/oracle-manifest")) };
const _rAutoWake = { ...(await import("../src/commands/shared/should-auto-wake")) };
const _rAway = { ...(await import("../src/core/worklog/presence-away")) };

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
const realAway = { isPaneAway: _rAway.isPaneAway };

let mockActive = false;
// kobo-483: fail-closed, same pattern as wake-cmd-cmdwake-coverage.test.ts —
// see that file's header for the full rationale. `sendKeys` here injects
// real keystrokes into a real pane when it falls through.
let suiteStarted = false;

function realCallForbidden(label: string): never {
  throw new Error(
    `[kobo-483 fail-closed] mockActive was false for "${label}" after the test suite ` +
    `had already started — refusing to fall through to the real implementation. ` +
    `Fix the race, don't restore the real passthrough.`,
  );
}

function resolveMock<T>(fake: () => T, real: () => T, label: string): T {
  if (mockActive) return fake();
  if (!suiteStarted) return real();
  return realCallForbidden(label);
}

let paneAway = false;
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
  listSessions: async () => resolveMock(
    () => [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }],
    () => realSdk.listSessions(),
    "listSessions",
  ),
  capture: async (target: string, lines: number, host?: string) => resolveMock(() => "", () => realSdk.capture(target, lines, host), "capture"),
  sendKeys: async (target: string, text: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realSdk.sendKeys(target, text);
      return realCallForbidden("sendKeys");
    }
    order.push("sendKeys");
    if (sendKeysShouldThrow) throw new Error("pane vanished");
  },
  isAgentCommand: (cmd: string | null | undefined) => resolveMock(() => true, () => realSdk.isAgentCommand(cmd), "isAgentCommand"),
  findPeerForTarget: async (...args: Parameters<typeof realSdk.findPeerForTarget>) => resolveMock(() => null, () => realSdk.findPeerForTarget(...args), "findPeerForTarget"),
  resolveTarget: (...args: Parameters<typeof realSdk.resolveTarget>) => resolveMock(
    () => ({ type: "local" as const, target: "session:oracle.0" }),
    () => realSdk.resolveTarget(...args),
    "resolveTarget",
  ),
  curlFetch: async (...args: Parameters<typeof realSdk.curlFetch>) => resolveMock(
    () => ({ ok: true, data: { ok: true } }),
    () => realSdk.curlFetch(...args),
    "curlFetch",
  ),
  runHook: async (...args: unknown[]) => {
    if (!mockActive) {
      if (!suiteStarted) return realSdk.runHook("" as any, {} as any);
      return realCallForbidden("runHook");
    }
    runHookCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  ..._rConfig,
  loadConfig: () => resolveMock(
    () => ({ node: "test-node", oracle: "sender", port: 3456, namedPeers: [], commands: { default: "claude" } }),
    () => realConfig.loadConfig(),
    "loadConfig",
  ),
  cfgLimit: (...args: Parameters<typeof realConfig.cfgLimit>) => resolveMock(() => 120, () => realConfig.cfgLimit(...args), "cfgLimit"),
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  ..._rFeed,
  logMessage: (...args: unknown[]) => {
    if (!mockActive) {
      if (!suiteStarted) return realFeed.logMessage("" as any, "" as any, "" as any, "" as any);
      return realCallForbidden("logMessage");
    }
    logMessageCalls.push(args);
  },
  emitFeed: (...args: unknown[]) => {
    if (!mockActive) {
      if (!suiteStarted) return realFeed.emitFeed("" as any, "" as any, "" as any, "" as any, 0, {} as any);
      return realCallForbidden("emitFeed");
    }
    emitFeedCalls.push(args);
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  ..._rOracle,
  findOracle: (name: string) => resolveMock(() => ({ name: "oracle", node: "test-node" }), () => realOracle.findOracle(name), "findOracle"),
  loadManifestCached: () => resolveMock(() => [], () => realOracle.loadManifestCached(), "loadManifestCached"),
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  ..._rAutoWake,
  shouldAutoWake: (...args: Parameters<typeof realAutoWake.shouldAutoWake>) => resolveMock(
    () => ({ wake: false }),
    () => realAutoWake.shouldAutoWake(...args),
    "shouldAutoWake",
  ),
}));

mock.module(join(srcRoot, "src/core/worklog/presence-away"), () => ({
  ..._rAway,
  // kobo-483: made deterministic instead of exempted from the guard —
  // paneAway itself is already the fake's whole truth table (true/false), so
  // returning it directly covers both cases without ever needing a real
  // passthrough while mockActive is true. Standard resolveMock shape now,
  // same as every other site in this file.
  isPaneAway: (...args: Parameters<typeof realAway.isPaneAway>) =>
    resolveMock(() => paneAway, () => realAway.isPaneAway(...args), "isPaneAway"),
}));

const origExit = process.exit;
const origLog = console.log;
const origErr = console.error;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origSshClient = process.env.SSH_CLIENT;
const origSshConnection = process.env.SSH_CONNECTION;
const origSshTty = process.env.SSH_TTY;

const { cmdSend } = await import("../src/commands/shared/comm-send");

async function runCmd(inbox?: () => ReceiverInboxResult, extraOpts: Partial<Parameters<typeof cmdSend>[3]> = {}) {
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await cmdSend("oracle", "hello", false, {
      noVerifySubmit: true,
      ...extraOpts,
      receiverInbox: async () => {
        order.push("receiverInbox");
        return inbox ? inbox() : { ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" };
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
  suiteStarted = true; // kobo-483: never reset — marks "past the safe module-load window"
  paneAway = false;
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
  // kobo-592: mock.module() replaces the process-WIDE module registry, not a
  // per-file one — Bun keeps each mocked factory active for every LATER file
  // that shares this test run/worker, not just this file's own tests.
  // `suiteStarted` is deliberately never reset (kobo-483 — it's the
  // fail-closed trip-wire against a real sendKeys/curlFetch slipping through
  // if `mockActive` ever flips false mid-suite by a bug), so once this
  // file's tests finish, every later file calling any of these six modules
  // hits realCallForbidden instead of the real implementation — reproduced
  // live: running this file together with src/core/worklog/ in one process
  // turns a completely unrelated worklog test red on `cfgLimit`
  // (pushFeedEvent → src/config), because nothing ever gave the module
  // registry its real implementation back.
  //
  // Re-register each with the FULL original captured module (the `_r*`
  // namespace objects from the top of this file, not the narrower `real*`
  // convenience subsets used inside resolveMock — those omit every export
  // this file doesn't call, and mock.module's factory return value becomes
  // the ENTIRE module's exports, so restoring with the subset would silently
  // undefine everything else importers of these modules rely on).
  mock.module(join(srcRoot, "src/sdk"), () => _rSdk);
  mock.module(join(srcRoot, "src/config"), () => _rConfig);
  mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => _rFeed);
  mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => _rOracle);
  mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => _rAutoWake);
  mock.module(join(srcRoot, "src/core/worklog/presence-away"), () => _rAway);
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

describe("cmdSend away-gate park failure (kobo-288 silent-drop + log-lie)", () => {
  test("away + park fails (ok:false) → truthful error, never claims 'queued to inbox'", async () => {
    paneAway = true;

    await runCmd(() => ({ ok: false, oracle: "oracle", reason: "receiver repo not found for oracle" }));

    // Must NOT lie that it was queued/parked to inbox when nothing was written.
    expect(logs.join("\n")).not.toContain("queued to inbox");
    expect(logs.join("\n")).not.toContain("parked");
    // Must surface a real delivery failure and exit non-zero.
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("message NOT delivered");
    expect(errs.join("\n")).toContain("receiver repo not found for oracle");
    // No pane injection on the away path.
    expect(order).not.toContain("sendKeys");
  });

  test("away + park succeeds (ok:true) → parks quietly, no error, no injection", async () => {
    paneAway = true;

    await runCmd(() => ({ ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" }));

    expect(exitCode).toBeUndefined();
    expect(errs).toEqual([]);
    expect(logs.join("\n")).toContain("queued");
    expect(order).not.toContain("sendKeys");
  });
});

// kobo-306 — a room nudge (--queue-on-away) to an away lead must NOT drop: it queues for
// auto-delivery on /seat. Unlike a plain hey to an away oracle (park-inbox-only, above), the
// queueOnAway path survives even an inbox park FAILURE (the dispatch queue holds it), so it
// is never the silent drop kobo-305 diagnosed.
describe("cmdSend queue-on-away (kobo-306 room nudge to away lead)", () => {
  test("away + queueOnAway + park ok → queued for /seat return, no error, no injection", async () => {
    paneAway = true;

    await runCmd(
      () => ({ ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" }),
      { queueOnAway: true },
    );

    expect(exitCode).toBeUndefined();       // not a drop, not an error
    expect(errs).toEqual([]);
    expect(logs.join("\n")).toContain("queued");
    expect(order).not.toContain("sendKeys"); // still no live overtype of an away pane
  });

  test("away + queueOnAway + park FAILS → still queued (not the kobo-305 silent drop / exit-1)", async () => {
    paneAway = true;

    await runCmd(
      () => ({ ok: false, oracle: "oracle", reason: "receiver repo not found for oracle" }),
      { queueOnAway: true },
    );

    // The dispatch queue holds the nudge, so a failed inbox park is NOT fatal here —
    // contrast the plain away path (above) which exits 1 on the same park failure.
    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).not.toContain("message NOT delivered");
    expect(logs.join("\n")).toContain("queued");
    expect(order).not.toContain("sendKeys");
  });
});
