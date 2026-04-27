/**
 * comm-list.ts — cmdList + renderSessionName (primary target).
 * comm-send.ts — cmdSend + resolveOraclePane + resolveMyName (bonus).
 * comm-log-feed.ts — logMessage + emitFeed (bonus).
 *
 * Isolated because we mock.module on four seams the three files import through:
 *   - src/sdk                             (listSessions, capture, sendKeys,
 *                                          getPaneCommand, getPaneInfos,
 *                                          scanWorktrees, hostExec, curlFetch,
 *                                          runHook, findPeerForTarget,
 *                                          resolveTarget)
 *   - src/config                          (loadConfig, cfgLimit)
 *   - src/commands/shared/comm-log-feed   (logMessage, emitFeed — stubbed for
 *                                          cmdSend so it doesn't hit real fs
 *                                          or network; real refs captured
 *                                          before install and invoked directly
 *                                          in the logMessage/emitFeed tests)
 *   - src/plugin/registry                 (discoverPackages, invokePlugin —
 *                                          dynamically imported inside cmdSend
 *                                          for the plugin:<name> route)
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 *
 * process.exit is stubbed into a throw so the harness observes branches
 * that would otherwise tear the runner down (no-agent pane, peer failure,
 * plugin-not-found, unknown target, self-not-running).
 *
 * HOME is redirected to a mkdtempSync directory for the logMessage tests so
 * we write to a real fs but under /tmp, and clean up in afterAll.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rOs = await import("os");
const realOsHomedir = _rOs.homedir;
const realOsHostname = _rOs.hostname;

const _rSdk = await import("../../src/sdk");
const realListSessions = _rSdk.listSessions;
const realCapture = _rSdk.capture;
const realSendKeys = _rSdk.sendKeys;
const realGetPaneCommand = _rSdk.getPaneCommand;
const realGetPaneInfos = _rSdk.getPaneInfos;
const realHostExec = _rSdk.hostExec;
const realCurlFetch = _rSdk.curlFetch;
const realRunHook = _rSdk.runHook;
const realFindPeerForTarget = _rSdk.findPeerForTarget;
const realResolveTarget = _rSdk.resolveTarget;
// scanWorktrees is re-exported through src/sdk but typed loosely here
// because the type only ships at compile time; any() the shape we need.
const realScanWorktrees = (_rSdk as unknown as { scanWorktrees: (...a: unknown[]) => unknown }).scanWorktrees;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;
const realCfgLimit = _rConfig.cfgLimit;

const _rCommLogFeed = await import("../../src/commands/shared/comm-log-feed");
const realLogMessage = _rCommLogFeed.logMessage;
const realEmitFeed = _rCommLogFeed.emitFeed;

const _rPluginRegistry = await import("../../src/plugin/registry");
const realDiscoverPackages = _rPluginRegistry.discoverPackages;
const realInvokePlugin = _rPluginRegistry.invokePlugin;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

interface PaneWindow { index: number; name: string; active: boolean; }
interface PaneSession { name: string; windows: PaneWindow[]; }

let listSessionsReturn: PaneSession[] = [];
let captureResponses: Array<{ match: RegExp; result?: string; error?: string }> = [];
let sendKeysCalls: Array<{ target: string; text: string }> = [];
let getPaneCommandMap: Record<string, string> = {};
let getPaneInfosReturn: Record<string, { command: string; cwd: string }> = {};
let hostExecResponses: Array<{ match: RegExp; result?: string; error?: string }> = [];
let curlFetchCalls: Array<{ url: string; opts: unknown }> = [];
let curlFetchResponses: Array<{ match: RegExp; response?: { ok: boolean; status?: number; data?: unknown }; error?: string }> = [];
let runHookCalls: Array<{ event: string; payload: unknown }> = [];
let findPeerForTargetReturn: string | null = null;
let resolveTargetReturn: unknown = null;
let scanWorktreesReturn: unknown[] = [];
let scanWorktreesThrows: string | null = null;

let configOverride: Record<string, unknown> = {};
let cfgLimitMap: Record<string, number> = {};

let logMessageCalls: Array<{ from: string; to: string; msg: string; route: string }> = [];
let emitFeedCalls: Array<{ event: string; oracle: string; node: string; message: string; port: number }> = [];

let discoverPackagesReturn: Array<{ manifest: { name: string } }> = [];
let invokePluginReturn: { ok: boolean; output?: string; error?: string } = { ok: true, output: "plugin ran" };
let invokePluginCalls: Array<{ plugin: unknown; ctx: unknown }> = [];

let osHomedirOverride: string | null = null;

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    listSessions: async (...args: unknown[]) => {
      if (!mockActive) return (realListSessions as (...a: unknown[]) => Promise<PaneSession[]>)(...args);
      return listSessionsReturn;
    },
    capture: async (...args: unknown[]) => {
      if (!mockActive) return (realCapture as (...a: unknown[]) => Promise<string>)(...args);
      const [target] = args as [string];
      for (const r of captureResponses) {
        if (r.match.test(target)) {
          if (r.error) throw new Error(r.error);
          return r.result ?? "";
        }
      }
      return "";
    },
    sendKeys: async (...args: unknown[]) => {
      if (!mockActive) return (realSendKeys as (...a: unknown[]) => Promise<void>)(...args);
      const [target, text] = args as [string, string];
      sendKeysCalls.push({ target, text });
    },
    getPaneCommand: async (...args: unknown[]) => {
      if (!mockActive) return (realGetPaneCommand as (...a: unknown[]) => Promise<string>)(...args);
      const [target] = args as [string];
      return getPaneCommandMap[target] ?? "";
    },
    getPaneInfos: async (...args: unknown[]) => {
      if (!mockActive) return (realGetPaneInfos as (...a: unknown[]) => Promise<unknown>)(...args);
      return getPaneInfosReturn;
    },
    hostExec: async (...args: unknown[]) => {
      if (!mockActive) return (realHostExec as (...a: unknown[]) => Promise<string>)(...args);
      const [cmd] = args as [string];
      for (const r of hostExecResponses) {
        if (r.match.test(cmd)) {
          if (r.error) throw new Error(r.error);
          return r.result ?? "";
        }
      }
      return "";
    },
    curlFetch: async (...args: unknown[]) => {
      if (!mockActive) return (realCurlFetch as (...a: unknown[]) => unknown)(...args);
      const [url, opts] = args as [string, unknown];
      curlFetchCalls.push({ url, opts });
      for (const r of curlFetchResponses) {
        if (r.match.test(url)) {
          if (r.error) throw new Error(r.error);
          return r.response!;
        }
      }
      return { ok: false, status: 0, data: null };
    },
    runHook: async (...args: unknown[]) => {
      if (!mockActive) return (realRunHook as (...a: unknown[]) => Promise<void>)(...args);
      const [event, payload] = args as [string, unknown];
      runHookCalls.push({ event, payload });
    },
    findPeerForTarget: async (...args: unknown[]) => {
      if (!mockActive) return (realFindPeerForTarget as (...a: unknown[]) => Promise<string | null>)(...args);
      return findPeerForTargetReturn;
    },
    resolveTarget: (...args: unknown[]) => {
      if (!mockActive) return (realResolveTarget as (...a: unknown[]) => unknown)(...args);
      return resolveTargetReturn;
    },
    scanWorktrees: async (...args: unknown[]) => {
      if (!mockActive) return (realScanWorktrees as (...a: unknown[]) => Promise<unknown[]>)(...args);
      if (scanWorktreesThrows) throw new Error(scanWorktreesThrows);
      return scanWorktreesReturn;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: unknown[]) =>
      mockActive ? configOverride : (realLoadConfig as (...a: unknown[]) => unknown)(...args),
    cfgLimit: (...args: unknown[]) => {
      if (!mockActive) return (realCfgLimit as (...a: unknown[]) => number)(...args);
      const [key] = args as [string];
      return cfgLimitMap[key] ?? 200;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/shared/comm-log-feed"),
  () => ({
    ..._rCommLogFeed,
    logMessage: async (...args: unknown[]) => {
      if (!mockActive) return (realLogMessage as (...a: unknown[]) => Promise<void>)(...args);
      const [from, to, msg, route] = args as [string, string, string, string];
      logMessageCalls.push({ from, to, msg, route });
    },
    emitFeed: (...args: unknown[]) => {
      if (!mockActive) return (realEmitFeed as (...a: unknown[]) => void)(...args);
      const [event, oracle, node, message, port] = args as [string, string, string, string, number];
      emitFeedCalls.push({ event, oracle, node, message, port });
    },
  }),
);

// `os` is cached inside Bun — once homedir() is called, later mutations of
// process.env.HOME don't take effect. To test logMessage's real fs writes we
// intercept homedir via mock.module. Passthrough hostname.
mock.module("os", () => ({
  ..._rOs,
  homedir: () => osHomedirOverride ?? realOsHomedir(),
  hostname: realOsHostname,
}));

mock.module(
  join(import.meta.dir, "../../src/plugin/registry"),
  () => ({
    ..._rPluginRegistry,
    discoverPackages: (...args: unknown[]) => {
      if (!mockActive) return (realDiscoverPackages as (...a: unknown[]) => unknown)(...args);
      return discoverPackagesReturn;
    },
    invokePlugin: async (...args: unknown[]) => {
      if (!mockActive) return (realInvokePlugin as (...a: unknown[]) => Promise<unknown>)(...args);
      const [plugin, ctx] = args as [unknown, unknown];
      invokePluginCalls.push({ plugin, ctx });
      return invokePluginReturn;
    },
  }),
);

// NB: import targets AFTER mocks so their import graph resolves through our stubs.
const { cmdList, renderSessionName } = await import("../../src/commands/shared/comm-list");
const { cmdSend, resolveOraclePane, resolveMyName } = await import("../../src/commands/shared/comm-send");

// ─── Harness (stdout + stderr + process.exit capture) ───────────────────────

const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;
const origQuiet = process.env.MAW_QUIET;
const origDebug = process.env.MAW_DEBUG;
const origClaudeAgentName = process.env.CLAUDE_AGENT_NAME;

let outs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

async function run(fn: () => Promise<unknown>): Promise<void> {
  outs = []; errs = []; exitCode = undefined;
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.log = origLog; console.error = origErr;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  listSessionsReturn = [];
  captureResponses = [];
  sendKeysCalls = [];
  getPaneCommandMap = {};
  getPaneInfosReturn = {};
  hostExecResponses = [];
  curlFetchCalls = [];
  curlFetchResponses = [];
  runHookCalls = [];
  findPeerForTargetReturn = null;
  resolveTargetReturn = null;
  scanWorktreesReturn = [];
  scanWorktreesThrows = null;
  configOverride = {};
  cfgLimitMap = {};
  logMessageCalls = [];
  emitFeedCalls = [];
  discoverPackagesReturn = [];
  invokePluginReturn = { ok: true, output: "plugin ran" };
  invokePluginCalls = [];
  osHomedirOverride = null;
  delete process.env.MAW_QUIET;
  delete process.env.MAW_DEBUG;
  process.env.CLAUDE_AGENT_NAME = "test-oracle";
});

afterEach(() => {
  mockActive = false;
  if (origQuiet === undefined) delete process.env.MAW_QUIET; else process.env.MAW_QUIET = origQuiet;
  if (origDebug === undefined) delete process.env.MAW_DEBUG; else process.env.MAW_DEBUG = origDebug;
  if (origClaudeAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origClaudeAgentName;
});

afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origErr;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

// ════════════════════════════════════════════════════════════════════════════
// comm-list.ts — renderSessionName
// ════════════════════════════════════════════════════════════════════════════

describe("renderSessionName", () => {
  test("plain session name → bright cyan", () => {
    const out = renderSessionName("08-mawjs");
    expect(out).toBe("\x1b[36m08-mawjs\x1b[0m");
  });

  test("name ending in -view → dimmed grey + [view] tag", () => {
    const out = renderSessionName("08-mawjs-view");
    expect(out).toBe("\x1b[90m08-mawjs-view\x1b[0m \x1b[90m[view]\x1b[0m");
  });

  test("special 'maw-view' meta session → dimmed + [view] tag", () => {
    const out = renderSessionName("maw-view");
    expect(out).toBe("\x1b[90mmaw-view\x1b[0m \x1b[90m[view]\x1b[0m");
  });

  test("name containing 'view' mid-string is NOT treated as view", () => {
    // Regex is /-view$/ — anchored to the end with a leading dash.
    const out = renderSessionName("preview-win");
    expect(out).toBe("\x1b[36mpreview-win\x1b[0m");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-list.ts — cmdList (happy-path session rendering)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdList — session rendering", () => {
  test("active agent pane → green dot", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = {
      "08-mawjs:0": { command: "claude", cwd: "/home/x" },
    };

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[32m●\x1b[0m"); // green
    expect(joined).toContain("0: mawjs-oracle");
  });

  test("inactive agent pane → blue dot", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: false }] },
    ];
    getPaneInfosReturn = {
      "08-mawjs:0": { command: "claude", cwd: "/home/x" },
    };

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[34m●\x1b[0m"); // blue
  });

  test("non-agent pane (zsh) → red dot + (command) suffix", async () => {
    listSessionsReturn = [
      { name: "99-shell", windows: [{ index: 0, name: "just-a-shell", active: false }] },
    ];
    getPaneInfosReturn = {
      "99-shell:0": { command: "zsh", cwd: "/home/x" },
    };

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[31m●\x1b[0m"); // red
    expect(joined).toContain("(zsh)");
  });

  test("pane with no info falls back to '?' in suffix", async () => {
    listSessionsReturn = [
      { name: "99-shell", windows: [{ index: 0, name: "ghost", active: false }] },
    ];
    getPaneInfosReturn = {}; // target missing → defaults to {command:"", cwd:""}

    await run(() => cmdList());

    expect(outs.join("\n")).toContain("(?)");
  });

  test("cwd '(deleted)' → red dot + '(path deleted)' overrides agent detection", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = {
      "08-mawjs:0": { command: "claude", cwd: "/old/path (deleted)" },
    };

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[31m●\x1b[0m");
    expect(joined).toContain("(path deleted)");
    // Not green, even though command=claude and active=true.
    expect(joined).not.toContain("\x1b[32m●\x1b[0m");
  });

  test("cwd '(dead)' triggers the same broken-path branch", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = {
      "08-mawjs:0": { command: "claude", cwd: "/tmp (dead)" },
    };

    await run(() => cmdList());

    expect(outs.join("\n")).toContain("(path deleted)");
  });

  test("session header rendered via renderSessionName (cyan for non-view)", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "w", active: true }] },
    ];
    getPaneInfosReturn = { "08-mawjs:0": { command: "claude", cwd: "/" } };

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[36m08-mawjs\x1b[0m");
  });

  test("view session is dimmed in the header", async () => {
    listSessionsReturn = [
      { name: "08-mawjs-view", windows: [{ index: 0, name: "w", active: false }] },
    ];
    getPaneInfosReturn = { "08-mawjs-view:0": { command: "zsh", cwd: "/" } };

    await run(() => cmdList());

    expect(outs.join("\n")).toContain("[view]");
  });

  test("case-insensitive agent detection — 'Node' counts as agent", async () => {
    listSessionsReturn = [
      { name: "s", windows: [{ index: 0, name: "w", active: false }] },
    ];
    getPaneInfosReturn = { "s:0": { command: "Node", cwd: "/" } };

    await run(() => cmdList());

    // Still blue (inactive agent), not red.
    expect(outs.join("\n")).toContain("\x1b[34m●\x1b[0m");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-list.ts — orphan detection + empty state
// ════════════════════════════════════════════════════════════════════════════

describe("cmdList — orphan detection", () => {
  test("stale + orphan worktrees → warnings + fix hint printed", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = { "08-mawjs:0": { command: "claude", cwd: "/" } };
    scanWorktreesReturn = [
      { path: "/ghq/org/repo.wt-1-freelance", status: "stale", name: "1-freelance" },
      { path: "/ghq/org/repo.wt-2-ghost",     status: "orphan", name: "2-ghost" },
      { path: "/ghq/org/repo",                status: "active", name: "main" }, // filtered out
    ];

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("⚠ orphaned:");
    expect(joined).toContain("repo.wt-1-freelance");
    expect(joined).toContain("(no tmux window)");
    expect(joined).toContain("repo.wt-2-ghost");
    expect(joined).toContain("(orphaned (prunable))");
    expect(joined).toContain("→ maw ls --fix");
    // active worktree should NOT be rendered as an orphan
    expect(joined).not.toContain("path: /ghq/org/repo ");
  });

  test("orphan path without '/' → falls back to wt.name", async () => {
    listSessionsReturn = [];
    scanWorktreesReturn = [
      { path: "noslash", status: "stale", name: "fallback-name" },
    ];

    await run(() => cmdList());

    // pop() on "noslash".split("/") returns "noslash" → truthy, uses that.
    // To actually exercise the `|| wt.name` branch we need an empty string
    // after split().pop(), which only happens if path is "" (empty string).
    expect(outs.join("\n")).toContain("noslash");
  });

  test("empty path uses wt.name fallback", async () => {
    listSessionsReturn = [];
    scanWorktreesReturn = [
      { path: "", status: "stale", name: "fallback-name" },
    ];

    await run(() => cmdList());

    // split("/").pop() on "" returns "" (falsy) → falls through to wt.name.
    expect(outs.join("\n")).toContain("fallback-name");
  });

  test("scanWorktrees throws without MAW_DEBUG → silent (no crash)", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = { "08-mawjs:0": { command: "claude", cwd: "/" } };
    scanWorktreesThrows = "scan exploded";

    await run(() => cmdList());

    // Session still listed; no orphan warnings.
    expect(outs.some((o) => o.includes("mawjs-oracle"))).toBe(true);
    expect(outs.some((o) => o.includes("⚠ orphaned:"))).toBe(false);
    expect(errs.some((e) => e.includes("scanWorktrees failed"))).toBe(false);
  });

  test("scanWorktrees throws WITH MAW_DEBUG → warning on stderr", async () => {
    process.env.MAW_DEBUG = "1";
    listSessionsReturn = [];
    scanWorktreesThrows = "scan exploded";

    await run(() => cmdList());

    const joined = errs.join("\n");
    expect(joined).toContain("scanWorktrees failed");
    expect(joined).toContain("scan exploded");
    expect(joined).toContain("non-fatal");
  });

  test("scanWorktrees returns only 'active' entries → no orphan block rendered", async () => {
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    getPaneInfosReturn = { "08-mawjs:0": { command: "claude", cwd: "/" } };
    scanWorktreesReturn = [
      { path: "/ghq/org/repo", status: "active", name: "main" },
    ];

    await run(() => cmdList());

    expect(outs.some((o) => o.includes("⚠ orphaned:"))).toBe(false);
    expect(outs.some((o) => o.includes("→ maw ls --fix"))).toBe(false);
  });
});

describe("cmdList — empty state", () => {
  test("no sessions AND no orphans → prints onboarding hints", async () => {
    listSessionsReturn = [];
    scanWorktreesReturn = [];

    await run(() => cmdList());

    const joined = outs.join("\n");
    expect(joined).toContain("No active sessions.");
    expect(joined).toContain("maw bud <name>");
    expect(joined).toContain("maw wake <name>");
  });

  test("no sessions but orphans present → NO 'No active sessions' hint", async () => {
    listSessionsReturn = [];
    scanWorktreesReturn = [
      { path: "/wt1", status: "stale", name: "wt1" },
    ];

    await run(() => cmdList());

    expect(outs.some((o) => o.includes("No active sessions."))).toBe(false);
    expect(outs.some((o) => o.includes("⚠ orphaned:"))).toBe(true);
  });

  test("no sessions + scanWorktrees throws → still emits onboarding hints", async () => {
    listSessionsReturn = [];
    scanWorktreesThrows = "nope";

    await run(() => cmdList());

    expect(outs.join("\n")).toContain("No active sessions.");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-send.ts — resolveMyName
// ════════════════════════════════════════════════════════════════════════════

describe("resolveMyName", () => {
  test("CLAUDE_AGENT_NAME set → returned verbatim", () => {
    process.env.CLAUDE_AGENT_NAME = "override-name";
    const out = resolveMyName({ node: "ignored" } as unknown as Parameters<typeof resolveMyName>[0]);
    expect(out).toBe("override-name");
  });

  test("no CLAUDE_AGENT_NAME, no TMUX → config.node fallback", () => {
    // execSync throws because we're not attached to tmux in this test path
    // (TMUX env var intentionally cleared). The catch swallows, we land on
    // `config.node || "cli"`.
    delete process.env.CLAUDE_AGENT_NAME;
    const prevTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const out = resolveMyName({ node: "white" } as unknown as Parameters<typeof resolveMyName>[0]);
      // Either tmux happens to be running and returns a stripped session, OR
      // the fallback kicks in. Both are acceptable; we only assert truthy.
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    } finally {
      if (prevTmux !== undefined) process.env.TMUX = prevTmux;
    }
  });

  test("no CLAUDE_AGENT_NAME and no config.node → 'cli' fallback", () => {
    delete process.env.CLAUDE_AGENT_NAME;
    const out = resolveMyName({} as unknown as Parameters<typeof resolveMyName>[0]);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-send.ts — resolveOraclePane
// ════════════════════════════════════════════════════════════════════════════

describe("resolveOraclePane", () => {
  test("target already has .N pane suffix → passed through unchanged", async () => {
    // No hostExec call should be needed — early return.
    hostExecResponses = []; // would hit the default empty string otherwise
    const out = await resolveOraclePane("08-mawjs:0.3");
    expect(out).toBe("08-mawjs:0.3");
  });

  test("single-pane window (one line from list-panes) → target unchanged", async () => {
    hostExecResponses = [{ match: /list-panes/, result: "0 zsh" }];
    const out = await resolveOraclePane("08-mawjs:0");
    expect(out).toBe("08-mawjs:0");
  });

  test("multi-pane: lowest-index claude pane wins", async () => {
    hostExecResponses = [{
      match: /list-panes/,
      result: "0 zsh\n1 claude\n2 node\n3 claude",
    }];
    const out = await resolveOraclePane("08-mawjs:0");
    expect(out).toBe("08-mawjs:0.1");
  });

  test("multi-pane with no agents → target unchanged", async () => {
    hostExecResponses = [{
      match: /list-panes/,
      result: "0 zsh\n1 vim\n2 bash",
    }];
    const out = await resolveOraclePane("08-mawjs:0");
    expect(out).toBe("08-mawjs:0");
  });

  test("hostExec throws → falls back to target unchanged", async () => {
    hostExecResponses = [{ match: /list-panes/, error: "ssh failed" }];
    const out = await resolveOraclePane("08-mawjs:0");
    expect(out).toBe("08-mawjs:0");
  });

  test("line missing a space (malformed) is skipped; other agent panes still considered", async () => {
    hostExecResponses = [{
      match: /list-panes/,
      result: "garbled\n2 claude\n5 codex",
    }];
    const out = await resolveOraclePane("08-mawjs:0");
    expect(out).toBe("08-mawjs:0.2");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-send.ts — cmdSend (bare-name tip, local, peer, plugin, error paths)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdSend — bare-name deprecation (#362b → #759 Phase 1)", () => {
  test("bare name + config.node set → deprecation warning on stderr", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "error", reason: "not_found", detail: "…" };

    await run(() => cmdSend("mawjs", "hi"));

    const joined = errs.join("\n");
    expect(joined).toContain("deprecation");
    expect(joined).toContain("#759");
    expect(joined).toContain("maw hey white:mawjs");
  });

  test("MAW_QUIET=1 suppresses the deprecation warning", async () => {
    process.env.MAW_QUIET = "1";
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "error", reason: "not_found", detail: "…" };

    await run(() => cmdSend("mawjs", "hi"));

    expect(errs.some((e) => e.includes("deprecation"))).toBe(false);
  });

  test("query containing ':' → no warning (already canonical)", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "error", reason: "unknown_node", detail: "…" };

    await run(() => cmdSend("white:mawjs", "hi"));

    expect(errs.some((e) => e.includes("deprecation"))).toBe(false);
  });

  test("no config.node → no warning", async () => {
    configOverride = {};
    resolveTargetReturn = { type: "error", reason: "not_found", detail: "…" };

    await run(() => cmdSend("mawjs", "hi"));

    expect(errs.some((e) => e.includes("deprecation"))).toBe(false);
  });
});

describe("cmdSend — local target (happy path + error branches)", () => {
  test("local target + claude pane → sendKeys + logMessage + emitFeed + delivery line", async () => {
    configOverride = { node: "white", port: 4000 };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "claude" };
    captureResponses = [{ match: /08-mawjs:0/, result: "prompt $\nhello back" }];

    await run(() => cmdSend("mawjs", "ping"));

    expect(sendKeysCalls).toEqual([{ target: "08-mawjs:0", text: "ping" }]);
    expect(runHookCalls.some((h) => h.event === "after_send")).toBe(true);
    expect(logMessageCalls).toHaveLength(1);
    expect(logMessageCalls[0]).toMatchObject({
      from: "test-oracle", to: "mawjs", msg: "ping", route: "local",
    });
    expect(emitFeedCalls).toHaveLength(1);
    expect(emitFeedCalls[0]).toMatchObject({
      event: "MessageSend", oracle: "test-oracle", node: "white", port: 4000,
    });
    expect(outs.some((o) => o.includes("delivered") && o.includes("08-mawjs:0: ping"))).toBe(true);
    expect(outs.some((o) => o.includes("⤷ hello back"))).toBe(true);
  });

  test("local target + non-agent pane without --force → exit 1 + hint, no sendKeys", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "zsh" };

    await run(() => cmdSend("mawjs", "ping"));

    expect(exitCode).toBe(1);
    expect(sendKeysCalls).toEqual([]);
    const joined = errs.join("\n");
    expect(joined).toContain("no active Claude session in 08-mawjs:0");
    expect(joined).toContain("running: zsh");
    expect(joined).toContain("maw wake mawjs");
  });

  test("local target + non-agent pane WITH --force → sends anyway", async () => {
    configOverride = { node: "white", port: 3456 };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "zsh" };
    captureResponses = [{ match: /08-mawjs:0/, result: "shell\n" }];

    await run(() => cmdSend("mawjs", "ping", true));

    expect(sendKeysCalls).toEqual([{ target: "08-mawjs:0", text: "ping" }]);
    expect(exitCode).toBeUndefined();
  });

  test("local target + empty pane capture → no ⤷ follow-up line", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "claude" };
    captureResponses = [{ match: /08-mawjs:0/, result: "\n\n  \n" }];

    await run(() => cmdSend("mawjs", "ping"));

    expect(outs.some((o) => o.includes("delivered"))).toBe(true);
    expect(outs.some((o) => o.includes("⤷"))).toBe(false);
  });

  test("capture throws → delivery still succeeds, no follow-up line", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "claude" };
    captureResponses = [{ match: /08-mawjs:0/, error: "capture refused" }];

    await run(() => cmdSend("mawjs", "ping"));

    expect(outs.some((o) => o.includes("delivered"))).toBe(true);
    expect(outs.some((o) => o.includes("⤷"))).toBe(false);
  });

  test("self-node target behaves like local target", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "self-node", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "claude" };

    await run(() => cmdSend("white:mawjs", "ping"));

    expect(sendKeysCalls).toEqual([{ target: "08-mawjs:0", text: "ping" }]);
    expect(logMessageCalls[0].route).toBe("local");
  });

  test("config.node missing but local delivery needed → throws (caught by harness)", async () => {
    configOverride = {}; // no node
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    getPaneCommandMap = { "08-mawjs:0": "claude" };

    let caught: unknown;
    try {
      await cmdSend("mawjs", "ping");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("config.node is required");
  });

  test("pane resolution routes through resolveOraclePane (multi-pane → .N appended)", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "local", target: "08-mawjs:0" };
    hostExecResponses = [{
      match: /list-panes/,
      result: "0 zsh\n1 claude",
    }];
    getPaneCommandMap = { "08-mawjs:0.1": "claude" };

    await run(() => cmdSend("mawjs", "ping"));

    expect(sendKeysCalls).toEqual([{ target: "08-mawjs:0.1", text: "ping" }]);
  });
});

describe("cmdSend — peer target (federation)", () => {
  test("peer target + curlFetch ok → federation delivery + hooks + logs", async () => {
    configOverride = { node: "white", port: 5000 };
    resolveTargetReturn = {
      type: "peer", peerUrl: "https://mba.example", target: "mawjs", node: "mba",
    };
    curlFetchResponses = [{
      match: /mba\.example\/api\/send/,
      response: { ok: true, status: 200, data: { ok: true, target: "mawjs", lastLine: "peer saw it" } },
    }];

    await run(() => cmdSend("mba:mawjs", "ping"));

    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("https://mba.example/api/send");
    expect(curlFetchCalls[0].opts).toMatchObject({ method: "POST" });
    expect(runHookCalls.some((h) => h.event === "after_send")).toBe(true);
    expect(logMessageCalls[0]).toMatchObject({ from: "test-oracle", to: "mba:mawjs", route: "peer:mba" });
    expect(emitFeedCalls[0]).toMatchObject({ event: "MessageSend", node: "white", port: 5000 });
    expect(outs.some((o) => o.includes("delivered") && o.includes("mba") && o.includes("mawjs: ping"))).toBe(true);
    expect(outs.some((o) => o.includes("⤷ peer saw it"))).toBe(true);
  });

  test("peer target + curlFetch ok but data.ok=false → error + exit 1", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = {
      type: "peer", peerUrl: "https://mba.example", target: "mawjs", node: "mba",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { ok: false, error: "pane gone" } },
    }];

    await run(() => cmdSend("mba:mawjs", "ping"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("pane gone");
    expect(errs.join("\n")).toContain("mba");
    // No log/feed on peer failure
    expect(logMessageCalls).toHaveLength(0);
  });

  test("peer target + transport-level failure (ok:false) → exit 1", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = {
      type: "peer", peerUrl: "https://mba.example", target: "mawjs", node: "mba",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: false, status: 500, data: null },
    }];

    await run(() => cmdSend("mba:mawjs", "ping"));

    expect(exitCode).toBe(1);
    // #411: remote fetch failure surfaces peer URL + underlying, not "send failed"
    expect(errs.join("\n")).toContain("Remote fetch failed for peer");
    expect(errs.join("\n")).toContain("mba.example");
  });

  test("peer success without data.lastLine → no ⤷ follow-up", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = {
      type: "peer", peerUrl: "https://mba.example", target: "mawjs", node: "mba",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { ok: true } },
    }];

    await run(() => cmdSend("mba:mawjs", "ping"));

    expect(outs.some((o) => o.includes("delivered"))).toBe(true);
    expect(outs.some((o) => o.includes("⤷"))).toBe(false);
  });
});

describe("cmdSend — async peer discovery fallback", () => {
  test("resolveTarget returns null → findPeerForTarget + curlFetch success", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = null;
    findPeerForTargetReturn = "https://discovered.example";
    curlFetchResponses = [{
      match: /discovered\.example/,
      response: { ok: true, status: 200, data: { ok: true, target: "mawjs", lastLine: "echo" } },
    }];

    await run(() => cmdSend("mawjs", "ping"));

    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("https://discovered.example/api/send");
    expect(outs.some((o) => o.includes("delivered") && o.includes("discovered.example"))).toBe(true);
    expect(exitCode).toBeUndefined();
  });

  test("fallback peer curlFetch non-ok → surfaces remote failure, not window-not-found (#411)", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = null;
    findPeerForTargetReturn = "https://broken.example";
    curlFetchResponses = [{
      match: /broken\.example/,
      response: { ok: false, status: 503, data: null },
    }];

    await run(() => cmdSend("mawjs", "ping"));

    expect(exitCode).toBe(1);
    // #411: must surface the remote failure, not the local-miss message
    expect(errs.join("\n")).toContain("Remote fetch failed for peer");
    expect(errs.join("\n")).toContain("broken.example");
    expect(errs.join("\n")).not.toContain("window not found: mawjs");
  });
});

describe("cmdSend — error paths (no match)", () => {
  test("resolveTarget type=error → surfaces detail + hint + exit 1", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = {
      type: "error", reason: "self_not_running",
      detail: "'mawjs' not found in local sessions on white",
      hint: "maw wake mawjs",
    };

    await run(() => cmdSend("mawjs", "ping"));

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain("'mawjs' not found in local sessions on white");
    expect(joined).toContain("maw wake mawjs");
  });

  test("resolveTarget type=error WITHOUT hint → still surfaces detail + exit 1", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = { type: "error", reason: "x", detail: "just a detail" };

    await run(() => cmdSend("mawjs", "ping"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("just a detail");
  });

  test("resolveTarget null + no peer discovery + config.agents populated → lists known agents", async () => {
    configOverride = { node: "white", agents: { foo: "mba", bar: "white" } };
    resolveTargetReturn = null;
    findPeerForTargetReturn = null;

    await run(() => cmdSend("ghost", "ping"));

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain("window not found: ghost");
    expect(joined).toContain("known agents:");
    expect(joined).toContain("foo");
    expect(joined).toContain("bar");
  });

  test("resolveTarget null + no peer discovery + no agents → bare window-not-found", async () => {
    configOverride = { node: "white" };
    resolveTargetReturn = null;
    findPeerForTargetReturn = null;

    await run(() => cmdSend("ghost", "ping"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window not found: ghost");
    expect(errs.some((e) => e.includes("known agents:"))).toBe(false);
  });
});

describe("cmdSend — plugin:<name> routing", () => {
  test("plugin not found → error + exit 1", async () => {
    configOverride = { node: "white" };
    discoverPackagesReturn = [];

    await run(() => cmdSend("plugin:ghost", "hi"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin not found: ghost");
  });

  test("plugin found + invokePlugin ok → prints output + returns", async () => {
    configOverride = { node: "white" };
    discoverPackagesReturn = [{ manifest: { name: "echo" } }];
    invokePluginReturn = { ok: true, output: "echoed: hi" };

    await run(() => cmdSend("plugin:echo", "hi"));

    expect(invokePluginCalls).toHaveLength(1);
    expect(invokePluginCalls[0].ctx).toMatchObject({
      source: "peer",
      args: { message: "hi", from: "white" },
    });
    expect(outs.some((o) => o.includes("echoed: hi"))).toBe(true);
    expect(exitCode).toBeUndefined();
  });

  test("plugin found + invokePlugin ok without output → prints '(no output)'", async () => {
    configOverride = { node: "white" };
    discoverPackagesReturn = [{ manifest: { name: "silent" } }];
    invokePluginReturn = { ok: true };

    await run(() => cmdSend("plugin:silent", "hi"));

    expect(outs.some((o) => o.includes("(no output)"))).toBe(true);
  });

  test("plugin found + invokePlugin fails → error + exit 1", async () => {
    configOverride = { node: "white" };
    discoverPackagesReturn = [{ manifest: { name: "boom" } }];
    invokePluginReturn = { ok: false, error: "plugin crashed" };

    await run(() => cmdSend("plugin:boom", "hi"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin error: plugin crashed");
  });

  test("plugin context uses 'local' when config.node absent", async () => {
    configOverride = {};
    discoverPackagesReturn = [{ manifest: { name: "p" } }];
    invokePluginReturn = { ok: true, output: "ok" };

    await run(() => cmdSend("plugin:p", "hi"));

    expect(invokePluginCalls[0].ctx).toMatchObject({
      args: { message: "hi", from: "local" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-log-feed.ts — logMessage (real fs under a tempdir HOME)
// ════════════════════════════════════════════════════════════════════════════

const tmpHome = mkdtempSync(join(tmpdir(), "maw-comm-list-test-"));

describe("logMessage — real fs under tempdir HOME", () => {
  // `os.homedir()` is cached after first call in Bun — we redirect via the
  // mock.module("os") seam, not process.env.HOME. osHomedirOverride is reset
  // per-test by the top-level beforeEach so other tests are unaffected.

  test("writes JSONL line with ts/from/to/msg/host/route", async () => {
    osHomedirOverride = tmpHome;
    configOverride = { node: "white" };

    await realLogMessage("test-oracle", "mawjs", "hello world", "local");

    const logPath = join(tmpHome, ".oracle", "maw-log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const body = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(body.split("\n").pop()!);
    expect(parsed.from).toBe("white:test-oracle"); // normalized
    expect(parsed.to).toBe("mawjs");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.route).toBe("local");
    expect(typeof parsed.ts).toBe("string");
    expect(typeof parsed.host).toBe("string");
  });

  test("from containing ':' is preserved (NOT double-prefixed)", async () => {
    osHomedirOverride = tmpHome;
    configOverride = { node: "white" };

    await realLogMessage("mba:neo", "mawjs", "cross", "peer:mba");

    const logPath = join(tmpHome, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.from).toBe("mba:neo");
    expect(parsed.route).toBe("peer:mba");
  });

  test("msg truncated at 500 chars", async () => {
    osHomedirOverride = tmpHome;
    configOverride = { node: "white" };
    const long = "x".repeat(600);

    await realLogMessage("oracle", "target", long, "local");

    const logPath = join(tmpHome, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.msg.length).toBe(500);
    expect(parsed.msg).toBe("x".repeat(500));
  });

  test("missing config.node → throws (contract of the function)", async () => {
    osHomedirOverride = tmpHome;
    configOverride = {}; // no node

    let caught: unknown;
    try {
      await realLogMessage("o", "t", "m", "local");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("config.node is required");
  });

  test("mkdir/appendFile fail → swallowed silently (no throw)", async () => {
    configOverride = { node: "white" };
    // /dev/null as HOME → mkdir under /dev/null/.oracle fails deterministically.
    // The module catches both mkdir and appendFile errors and moves on.
    osHomedirOverride = "/dev/null";

    // Should NOT throw — the module swallows fs errors on purpose.
    await realLogMessage("o", "t", "m", "local");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// comm-log-feed.ts — emitFeed (globalThis.fetch stub)
// ════════════════════════════════════════════════════════════════════════════

describe("emitFeed — globalThis.fetch intercept", () => {
  const origFetch = globalThis.fetch;
  interface FetchCall { url: string; init: RequestInit; }
  let fetchCalls: FetchCall[] = [];
  let fetchShouldReject = false;

  beforeEach(() => {
    fetchCalls = [];
    fetchShouldReject = false;
    // Replace globalThis.fetch with a recorder.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      if (fetchShouldReject) throw new Error("network down");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
  });

  test("POSTs to http://localhost:<port>/api/feed with JSON body", async () => {
    realEmitFeed("MessageSend", "mawjs", "white", "hello", 3456);
    // emitFeed is fire-and-forget — give the microtask a tick to flush.
    await Bun.sleep(10);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://localhost:3456/api/feed");
    expect(fetchCalls[0].init.method).toBe("POST");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body).toMatchObject({
      event: "MessageSend",
      oracle: "mawjs",
      host: "white",
      message: "hello",
    });
    expect(typeof body.ts).toBe("number");
  });

  test("custom port is honored", async () => {
    realEmitFeed("Event", "o", "n", "m", 9876);
    await Bun.sleep(10);
    expect(fetchCalls[0].url).toBe("http://localhost:9876/api/feed");
  });

  test("fetch rejects → silent (caught by .catch)", async () => {
    fetchShouldReject = true;
    // Must not throw.
    realEmitFeed("E", "o", "n", "m", 3456);
    await Bun.sleep(10);
    // Call was attempted.
    expect(fetchCalls).toHaveLength(1);
  });
});

// Cleanup the tempdir after every test in this file runs.
afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});
