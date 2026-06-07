import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import type { MawConfig } from "../../src/config";
import type { Session } from "../../src/core/runtime/find-window";

let hostExecCalls: string[] = [];
let ghqHit = "";
let hostExecShouldReject = false;
let switchClientCalls: string[] = [];
let sendTextCalls: Array<[string, string]> = [];
let listWindowsImpl: (session: string) => Promise<Array<{ index: number; name: string; active: boolean }>> = async () => [];
let getPaneCommandsImpl: (targets: string[]) => Promise<Record<string, string>> = async () => ({});
let captureImpl: (target: string, lines: number, host?: string) => Promise<string> = async () => "$ ";
let resolveTargetReturn: unknown = { type: "local", target: "sess:oracle.0" };
let listSessionsReturn: Array<Session & { source?: string }> = [];
let getPaneCommandReturn = "claude";
let sendKeysCalls: Array<[string, string]> = [];
let runHookCalls: unknown[] = [];
let curlFetchCalls: unknown[] = [];
let findPeerReturn: string | null = null;
let logMessages: unknown[] = [];
let feedEvents: unknown[] = [];
let configValue: Record<string, any> = {};
let fleetSessions: Record<string, string | null> = {};
let manifestEntries: Array<{ name: string; node?: string }> = [];
let manifestShouldThrow = false;
let shouldAutoWakeResult = { wake: false };
let cmdWakeCalls: string[] = [];

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecShouldReject) throw new Error("host failed");
    if (cmd.includes("tmux display-message")) return "4242\n";
    if (cmd.includes("pgrep -P")) return "";
    return "";
  },
  tmux: {
    switchClient: async (session: string) => { switchClientCalls.push(session); },
    listWindows: async (session: string) => listWindowsImpl(session),
    getPaneCommands: async (targets: string[]) => getPaneCommandsImpl(targets),
    sendText: async (target: string, text: string) => { sendTextCalls.push([target, text]); },
  },
  listSessions: async () => listSessionsReturn,
  capture: async (target: string, lines: number, host?: string) => captureImpl(target, lines, host),
  sendKeys: async (target: string, text: string) => { sendKeysCalls.push([target, text]); },
  getPaneCommand: async () => getPaneCommandReturn,
  isAgentCommand: (cmd: string) => /claude|codex|node/i.test(cmd),
  findPeerForTarget: async () => findPeerReturn,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async (...args: unknown[]) => { curlFetchCalls.push(args); return { ok: false, status: 599, data: { error: "not mocked" } }; },
  runHook: async (...args: unknown[]) => { runHookCalls.push(args); },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async () => ghqHit,
  ghqList: async () => [],
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => configValue,
  cfgLimit: () => 80,
  buildCommand: (name: string) => `run ${name}`,
  buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && run ${name}`,
  cfgTimeout: () => 0,
}));

mock.module(import.meta.resolve("../../src/commands/shared/comm-log-feed"), () => ({
  logMessage: (...args: unknown[]) => { logMessages.push(args); },
  emitFeed: (...args: unknown[]) => { feedEvents.push(args); },
}));

mock.module(import.meta.resolve("../../src/lib/message-events"), () => ({
  buildMessageLifecycleFeedEvent: (input: Record<string, unknown>) => ({
    event: "MessageLifecycle",
    oracle: "sender",
    host: "local",
    message: String(input.text ?? ""),
    data: input,
  }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => null,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  resolveFleetSession: (oracle: string) => fleetSessions[oracle] ?? null,
}));

mock.module(import.meta.resolve("../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => {
    if (manifestShouldThrow) throw new Error("manifest failed");
    return manifestEntries;
  },
  findOracle: (name: string) => manifestEntries.find((entry) => entry.name === name),
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => shouldAutoWakeResult,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (name: string) => { cmdWakeCalls.push(name); },
}));

const wakeTarget = await import("../../src/commands/shared/wake-target.ts?coverage-core-shared-helpers");
const wakeSession = await import("../../src/commands/shared/wake-session.ts?coverage-core-shared-helpers");
const coreResolve = await import("../../src/core/resolve.ts?coverage-core-shared-helpers");
const routing = await import("../../src/core/routing.ts?coverage-core-shared-helpers");
const commSend = await import("../../src/commands/shared/comm-send.ts?coverage-core-shared-helpers");
const instancePid = await import("../../src/cli/instance-pid.ts?coverage-core-shared-helpers");

const originalEnv = {
  tmux: process.env.TMUX,
  mawHome: process.env.MAW_HOME,
  claudeName: process.env.CLAUDE_AGENT_NAME,
};
const originalExit = process.exit;
const originalOn = process.on;
const originalKill = process.kill;
const originalLog = console.log;
const originalError = console.error;
let tempHome = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  hostExecCalls = [];
  ghqHit = "";
  hostExecShouldReject = false;
  switchClientCalls = [];
  sendTextCalls = [];
  listWindowsImpl = async () => [];
  getPaneCommandsImpl = async () => ({});
  captureImpl = async () => "$ ";
  resolveTargetReturn = { type: "local", target: "sess:oracle.0" };
  listSessionsReturn = [];
  getPaneCommandReturn = "claude";
  sendKeysCalls = [];
  runHookCalls = [];
  curlFetchCalls = [];
  findPeerReturn = null;
  logMessages = [];
  feedEvents = [];
  configValue = {
    node: "m5",
    oracle: "sender",
    port: 3456,
    agents: {},
    namedPeers: [],
    peers: [],
    commands: {},
    env: {},
  };
  fleetSessions = {};
  manifestEntries = [];
  manifestShouldThrow = false;
  shouldAutoWakeResult = { wake: false };
  cmdWakeCalls = [];
  tempHome = mkdtempSync(join(tmpdir(), "maw-coverage-core-shared-"));
  process.env.MAW_HOME = tempHome;
  delete process.env.CLAUDE_AGENT_NAME;
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
});

afterEach(() => {
  process.exit = originalExit;
  process.on = originalOn;
  process.kill = originalKill;
  console.log = originalLog;
  console.error = originalError;
  if (originalEnv.tmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalEnv.tmux;
  if (originalEnv.mawHome === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = originalEnv.mawHome;
  if (originalEnv.claudeName === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = originalEnv.claudeName;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("coverage core shared helpers", () => {
  test("wake target parsing covers URL, issue URL, slug, suffix, and plain-name paths", () => {
    expect(wakeTarget.parseWakeTarget(" git@github.com:Soul-Brews-Studio/neo-oracle.git ")).toEqual({
      oracle: "neo",
      slug: "Soul-Brews-Studio/neo-oracle",
    });
    expect(wakeTarget.parseWakeTarget("https://github.com/Soul-Brews-Studio/neo-oracle/issues/42")).toEqual({
      oracle: "neo",
      slug: "Soul-Brews-Studio/neo-oracle",
      issueNum: 42,
    });
    expect(wakeTarget.parseWakeTarget("Soul-Brews-Studio/neo-oracle.git")).toEqual({
      oracle: "neo",
      slug: "Soul-Brews-Studio/neo-oracle",
    });
    expect(wakeTarget.parseWakeTarget("neo")).toBeNull();
  });

  test("ensureCloned skips existing ghq hits and degrades on clone failure", async () => {
    ghqHit = "/gh/Soul-Brews-Studio/neo-oracle";
    await wakeTarget.ensureCloned("Soul-Brews-Studio/neo-oracle");
    expect(hostExecCalls).toEqual([]);

    ghqHit = "";
    hostExecShouldReject = true;
    await wakeTarget.ensureCloned("Soul-Brews-Studio/missing-oracle");
    expect(hostExecCalls).toEqual(["ghq get github.com/Soul-Brews-Studio/missing-oracle"]);
    expect(logs.join("\n")).toContain("clone failed");
  });

  test("PID lock signal handlers remove the lock file before exiting", () => {
    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    process.on = ((event: string, listener: (...args: any[]) => void) => {
      (handlers[event] ??= []).push(listener);
      return process;
    }) as typeof process.on;
    const exits: Array<number | undefined> = [];
    process.exit = ((code?: number) => { exits.push(code); throw new Error(`exit:${code}`); }) as never;

    instancePid.acquirePidLock(null);
    expect(readFileSync(instancePid.pidFile(), "utf-8")).toBe(String(process.pid));
    expect(() => handlers.SIGTERM.at(-1)?.()).toThrow("exit:0");
    expect(instancePid.serveStatus()).toEqual({ pid: null, alive: false, file: instancePid.pidFile() });

    instancePid.acquirePidLock(null);
    expect(() => handlers.SIGINT.at(-1)?.()).toThrow("exit:0");
    expect(exits).toEqual([0, 0]);
    expect(instancePid.serveStatus()).toEqual({ pid: null, alive: false, file: instancePid.pidFile() });
  });

  test("pickOracle cleans reader listeners when data already contains a newline", async () => {
    const writes: string[] = [];
    const reader = new PassThrough() as NodeJS.ReadStream;
    const selectedPromise = coreResolve.pickOracle([
      { owner: "one", repo: "alpha-oracle" },
      { owner: "two", repo: "beta-oracle", path: "/gh/two/beta-oracle" },
    ], {
      stream: { write: (text: string) => { writes.push(text); return true; } },
      reader,
    });

    reader.write("2\nignored");
    const selected = await selectedPromise;

    expect(selected).toEqual({ owner: "two", repo: "beta-oracle", path: "/gh/two/beta-oracle" });
    expect(writes.join("")).toContain("Select [1-2]");
    expect((reader as EventEmitter).listenerCount("data")).toBe(0);
    expect((reader as EventEmitter).listenerCount("end")).toBe(0);
    reader.destroy();
  });

  test("wake session helpers cover attach, pane idleness, retry, and worktree allocation fallbacks", async () => {
    process.env.TMUX = "1";
    await wakeSession.attachToSession("live-session", { tmux: { switchClient: async (session: string) => { switchClientCalls.push(session); } } as any });
    expect(switchClientCalls).toEqual(["live-session"]);

    delete process.env.TMUX;
    const execs: string[] = [];
    await wakeSession.attachToSession("attach-session", { execSync: ((cmd: string) => { execs.push(cmd); return Buffer.from(""); }) as any });
    expect(execs).toEqual(["tmux attach-session -t attach-session"]);

    await expect(wakeSession.isPaneIdle("s:w", { hostExec: async () => "\n" } as any)).resolves.toBe(true);
    await expect(wakeSession.isPaneIdle("s:w", { hostExec: async (cmd: string) => cmd.includes("display-message") ? "4321\n" : "999\n" } as any)).resolves.toBe(false);
    await expect(wakeSession.isPaneIdle("s:w", { hostExec: async () => { throw new Error("tmux gone"); } } as any)).resolves.toBe(true);

    listWindowsImpl = async () => { throw new Error("no tmux"); };
    await expect(wakeSession.ensureSessionRunning("missing", undefined, undefined, { tmux: { listWindows: listWindowsImpl } } as any)).resolves.toBe(0);

    const retrySends: Array<[string, string]> = [];
    await expect(wakeSession.ensureSessionRunning("s", new Set(["skip"]), { idle: "/tmp/idle" }, {
      tmux: {
        listWindows: async () => [
          { index: 1, name: "skip", active: false },
          { index: 2, name: "busy", active: false },
          { index: 3, name: "idle", active: true },
          { index: 4, name: "gone", active: false },
        ],
        getPaneCommands: async () => ({ "s:skip": "zsh", "s:busy": "bash", "s:idle": "", "s:gone": "sh" }),
        sendText: async (target: string, text: string) => {
          retrySends.push([target, text]);
          if (target === "s:gone") throw new Error("window killed");
        },
      },
      hostExec: async (cmd: string) => {
        if (cmd.includes("busy") && cmd.includes("display-message")) return "111\n";
        if (cmd.includes("pgrep -P 111")) return "222\n";
        if (cmd.includes("display-message")) return "333\n";
        return "";
      },
      buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && run ${name}`,
      buildCommand: (name: string) => `run ${name}`,
      cfgTimeout: () => 0,
      sleep: async () => {},
      log: () => {},
    } as any)).resolves.toBe(1);
    expect(retrySends).toContainEqual(["s:idle", "cd /tmp/idle && run idle"]);

    const worktreeCommands: string[] = [];
    await expect(wakeSession.createWorktree("/repo's", "/tmp", "repo", "oracle", "named", [{ name: "named", path: "/tmp/repo.wt-named" }], {
      named: true,
      hostExec: async (cmd: string) => { worktreeCommands.push(cmd); if (cmd.includes("rev-parse")) throw new Error("empty repo"); return ""; },
      log: () => {},
    } as any)).rejects.toThrow("could not allocate worktree");
    expect(worktreeCommands.some(cmd => cmd.includes("commit --allow-empty"))).toBe(true);
  });

  test("routing covers manifest failure and exact unnumbered session-alias preference", () => {
    const config: MawConfig = {
      host: "local",
      port: 3456,
      ghqRoot: "/gh",
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: {},
      sessions: {},
      node: "m5",
      namedPeers: [],
      agents: {},
      peers: [],
    };

    manifestShouldThrow = true;
    expect(routing.resolveTarget("calliope", config, [])).toMatchObject({ type: "error", reason: "not_found" });

    manifestShouldThrow = false;
    expect(routing.resolveTarget("thclaws-thclaws", config, [
      { name: "69-thclaws-thclaws", windows: [{ index: 1, name: "thclaws-thclaws-oracle", active: true }] },
      { name: "70-thclaws-thclaws-oracle", windows: [{ index: 2, name: "helper", active: true }] },
    ])).toEqual({ type: "local", target: "69-thclaws-thclaws:1" });
  });

  test("comm send exported helpers cover signing, idle parsing, name resolution, and team windows", async () => {
    process.env.CLAUDE_AGENT_NAME = "env-sender";
    expect(commSend.resolveMyName({ node: "fallback" } as any)).toBe("env-sender");
    expect(commSend.formatSignedMessage(" hello", { node: "m5" }, "sender")).toBe(" [m5:sender] hello");
    expect(commSend.formatSignedMessage("/help", { node: "m5" }, "sender")).toBe("/help");
    expect(commSend.formatSignedMessage("$plan", { node: "m5" }, "sender")).toBe("$plan");
    expect(commSend.formatSignedMessage("[m5:other] hi", { node: "m5" }, "sender")).toBe("[m5:other] hi");
    expect(commSend.formatSignedMessage("", { node: "m5" }, "sender")).toBe("");

    await expect(commSend.checkPaneIdle("s:w", undefined, { captureFn: async () => "\u001b[32muser@host$\u001b[0m " } as any)).resolves.toEqual({ idle: true, lastInput: "" });
    await expect(commSend.checkPaneIdle("s:w", undefined, { captureFn: async () => "user@host$ typing now" } as any)).resolves.toEqual({ idle: false, lastInput: "typing now" });
    await expect(commSend.checkPaneIdle("s:w", undefined, { captureFn: async () => "agent output" } as any)).resolves.toEqual({ idle: true, lastInput: "" });
    await expect(commSend.checkPaneIdle("s:w", undefined, { captureFn: async () => { throw new Error("capture failed"); } } as any)).resolves.toEqual({ idle: true, lastInput: "" });

    expect(await commSend.resolveOraclePane("s:w", { tmuxRun: async () => "not-a-pane-row\n1 claude\n0 codex\n", isAgentCommandFn: (cmd) => cmd === "claude" || cmd === "codex" })).toBe("s:w.0");
    expect(commSend.resolveTeamWorkspaceMemberTarget("squad", "neo", [
      { name: "squad", windows: [{ index: 1, name: "neo", active: true }] },
    ] as any)).toBe("squad:neo");
  });


  test("comm send bare-target error formatters include local-only guidance", () => {
    expect(commSend.formatBareNameError("ghost")).toContain("bare target 'ghost' not found locally");
    const ambiguous = commSend.formatBareNameAmbiguousError("neo", ["1-neo:neo", "2-neo:neo"]);
    expect(ambiguous).toContain("bare target 'neo' is ambiguous");
    expect(ambiguous).toContain("1-neo:neo");
  });

});
