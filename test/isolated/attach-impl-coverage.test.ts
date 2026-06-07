/**
 * Targeted isolated coverage for src/vendor/mpr-plugins/attach/impl.ts.
 *
 * `cmdAttach` shells out through Bun.spawn and imports process-global mocks, so
 * this file runs only under scripts/test-isolated.sh and keeps all dependencies
 * mocked at the module boundary.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";


// Reset process-wide mocks before registering this file's shims.
mock.restore();

const attachRoot = join(import.meta.dir, "../../src/vendor/mpr-plugins/attach");

type ResolveResult =
  | { tier: 1; sessionName: string; windowName?: string; ambiguousCandidates?: string[] }
  | { tier: 2; fleetName: string; ambiguousCandidates?: string[] }
  | { tier: 3; sessionName: string; node: string; peerUrl: string; sshAlias: string }
  | { tier: "error"; error: string; hint?: string }
  | null;

type ResolveCall = {
  target: string;
  opts: { fuzzy?: boolean; federation?: boolean };
  depsUseMockedListSessions: boolean;
  depsUseMockedLoadFleet: boolean;
};

let sessions: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let fleet: Array<{ name: string; windows: Array<{ name: string; repo?: string }> }> = [];
let resolveQueue: ResolveResult[] = [];
let resolveCalls: ResolveCall[] = [];
let spawnCalls: string[][] = [];
let spawnExitCode = 0;
let spawnStdout = "";
let spawnThrowsOnPipe = false;
let tmuxAttachCalls: string[] = [];
let tmuxAttachError: Error | null = null;
let attachSshCalls: unknown[] = [];
let logs: string[] = [];
let errors: string[] = [];

const original = {
  log: console.log,
  error: console.error,
  spawn: Bun.spawn,
  stdinIsTTY: process.stdin.isTTY,
};

const listSessions = async () => sessions;
const loadFleet = () => fleet;

const sdkMock = () => ({
  getGhqRoot: () => "/tmp/ghq",
  hostExec: async () => "",
  capture: async () => "",
  sendKeys: async () => undefined,
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false }),
  findPeerForTarget: async () => null,
  listSessions,
  loadFleetCore: loadFleet,
  runHook: async () => undefined,
  withPaneLock: async (fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "%1",
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  Tmux: class { async killSession() {} },
  tmuxCmd: () => "tmux",
  resolveSocket: () => undefined,
  tmux: { listPaneIds: async () => new Set<string>(), listSessions: async () => [] },
  UserError: class UserError extends Error { readonly isUserError = true; },
});
mock.module("maw-js/sdk", sdkMock);
mock.module(import.meta.resolve("../../src/sdk"), sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), sdkMock);

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxAttach: (target: string) => {
    tmuxAttachCalls.push(target);
    if (tmuxAttachError) throw tmuxAttachError;
  },
}));

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/attach-ssh/index"), () => ({
  default: {
    execute: async (target: unknown) => {
      attachSshCalls.push(target);
    },
  },
}));

mock.module(join(attachRoot, "resolve-attach-target"), () => ({
  resolveAttachTarget: async (
    target: string,
    deps: { listSessions: typeof listSessions; loadFleet: typeof loadFleet },
    opts: { fuzzy?: boolean } = {},
  ) => {
    resolveCalls.push({
      target,
      opts,
      depsUseMockedListSessions: deps.listSessions === listSessions,
      depsUseMockedLoadFleet: deps.loadFleet === loadFleet,
    });
    return resolveQueue.shift() ?? null;
  },
}));

const { cmdAttach } = await import("../../src/vendor/mpr-plugins/attach/impl.ts?attach-impl-coverage");

beforeEach(() => {
  sessions = [];
  fleet = [];
  resolveQueue = [];
  resolveCalls = [];
  spawnCalls = [];
  spawnExitCode = 0;
  spawnStdout = "";
  spawnThrowsOnPipe = false;
  tmuxAttachCalls = [];
  tmuxAttachError = null;
  attachSshCalls = [];
  logs = [];
  errors = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  Bun.spawn = ((cmd: string[], opts?: { stdin?: string; stdout?: string; stderr?: string }) => {
    spawnCalls.push([...cmd]);
    if (opts?.stdout === "pipe") {
      if (spawnThrowsOnPipe) throw new Error("tmux display failed");
      return {
        stdout: new Response(spawnStdout).body,
        exited: Promise.resolve(spawnExitCode),
      } as ReturnType<typeof Bun.spawn>;
    }
    expect(opts).toMatchObject({ stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return { exited: Promise.resolve(spawnExitCode) } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  delete process.env.TMUX_PANE;
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  Bun.spawn = original.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original.stdinIsTTY });
});

afterAll(() => {
  mock.restore();
});

describe("attach impl command routing", () => {
  test("requires a target name before resolving or spawning", async () => {
    await expect(cmdAttach("")).rejects.toThrow("name required");

    expect(errors.join("\n")).toContain("usage: maw attach <name>");
    expect(resolveCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  test("dry-runs a missing local target without spawning wake", async () => {
    resolveQueue = [null];

    await cmdAttach("ghost", { dryRun: true });

    expect(logs.join("\n")).toContain("[dry-run] 'ghost' not local or federated");
    expect(spawnCalls).toEqual([]);
    expect(resolveCalls).toEqual([
      {
        target: "ghost",
        // #1911 — attach opts in to preferOracleWindow so multi-window sessions
        // resolve to session:window instead of last-active.
        opts: { federation: true, preferOracleWindow: true },
        depsUseMockedListSessions: true,
        depsUseMockedLoadFleet: true,
      },
    ]);
  });

  test("delegates a miss to wake, fuzzy re-resolves, then attaches to the live session", async () => {
    resolveQueue = [null, { tier: 1, sessionName: "01-Somwind" }];

    await cmdAttach("wind");

    expect(spawnCalls).toEqual([["maw", "wake", "wind"]]);
    expect(tmuxAttachCalls).toEqual(["01-Somwind"]);
    expect(resolveCalls.map((call) => ({ target: call.target, opts: call.opts }))).toEqual([
      // #1911 — both passes opt in to preferOracleWindow.
      { target: "wind", opts: { federation: true, preferOracleWindow: true } },
      { target: "wind", opts: { fuzzy: true, preferOracleWindow: true } },
    ]);
    expect(logs.join("\n")).toContain("'wind' not local or federated");
    expect(logs.join("\n")).toContain("attaching to 01-Somwind");
  });

  test("reports a wake miss when fuzzy re-resolve still finds no live session", async () => {
    resolveQueue = [null, null];

    await expect(cmdAttach("ghost")).rejects.toThrow("wake did not create a session for 'ghost'");

    expect(spawnCalls).toEqual([["maw", "wake", "ghost"]]);
    expect(errors.join("\n")).toContain("'ghost' still not running after wake");
    expect(resolveCalls[1].opts).toEqual({ fuzzy: true, preferOracleWindow: true });
  });

  test("prints ambiguity candidates and refuses side effects", async () => {
    resolveQueue = [{ tier: 1, sessionName: "01-alpha", ambiguousCandidates: ["01-alpha", "02-alpha"] }];

    await expect(cmdAttach("alpha")).rejects.toThrow("ambiguous: alpha");

    const output = errors.join("\n");
    expect(output).toContain("'alpha' is ambiguous");
    expect(output).toContain("01-alpha");
    expect(output).toContain("02-alpha");
    expect(spawnCalls).toEqual([]);
  });

  test("prints resolver errors without waking or attaching", async () => {
    resolveQueue = [{
      tier: "error",
      error: "peer 'badnode' not found — check maw peers list",
      hint: "use: maw peers list",
    }];

    await expect(cmdAttach("badnode:ghost")).rejects.toThrow("peer 'badnode' not found");

    expect(errors.join("\n")).toContain("peer 'badnode' not found");
    expect(errors.join("\n")).toContain("use: maw peers list");
    expect(spawnCalls).toEqual([]);
    expect(tmuxAttachCalls).toEqual([]);
    expect(attachSshCalls).toEqual([]);
  });

  test("handles Tier 3 dry-run and remote attach strategy handoff", async () => {
    const remote = {
      tier: 3 as const,
      node: "alpha",
      sessionName: "volt-oracle",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
    };

    resolveQueue = [remote];
    await cmdAttach("alpha:volt-oracle", { dryRun: true });
    expect(logs.join("\n")).toContain("[dry-run] Tier 3 (remote) — would attach to alpha:volt-oracle via ssh alpha@white.wg");
    expect(attachSshCalls).toEqual([]);
    expect(tmuxAttachCalls).toEqual([]);

    logs = [];
    resolveQueue = [remote];
    await cmdAttach("alpha:volt-oracle");
    expect(logs.join("\n")).toContain("attaching to alpha:volt-oracle via ssh alpha@white.wg");
    expect(attachSshCalls).toEqual([remote]);
    expect(tmuxAttachCalls).toEqual([]);
  });

  test("rejects remote attach shell mode before strategy handoff", async () => {
    resolveQueue = [{
      tier: 3,
      node: "alpha",
      sessionName: "volt-oracle",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
    }];

    await expect(cmdAttach("alpha:volt-oracle", { shell: true })).rejects.toThrow("remote attach does not support --shell");

    expect(errors.join("\n")).toContain("remote attach does not support --shell");
    expect(attachSshCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  test("handles Tier 1 dry-run, live attach, and spawn failure paths", async () => {
    resolveQueue = [{ tier: 1, sessionName: "01-live" }];
    await cmdAttach("live", { dryRun: true });
    expect(logs.join("\n")).toContain("[dry-run] Tier 1 (live) — would attach to 01-live");
    expect(spawnCalls).toEqual([]);

    logs = [];
    resolveQueue = [{ tier: 1, sessionName: "01-live" }];
    await cmdAttach("live");
    expect(spawnCalls).toEqual([]);
    expect(tmuxAttachCalls).toEqual(["01-live"]);
    expect(logs.join("\n")).toContain("attaching to 01-live");

    tmuxAttachCalls = [];
    tmuxAttachError = new Error("tmux attach failed");
    resolveQueue = [{ tier: 1, sessionName: "01-broken" }];
    await expect(cmdAttach("broken")).rejects.toThrow("tmux attach failed");
    expect(spawnCalls).toEqual([]);
    expect(tmuxAttachCalls).toEqual(["01-broken"]);
  });

  test("Tier 1 attach preserves resolved oracle window target", async () => {
    resolveQueue = [{ tier: 1, sessionName: "01-yd-patient-flow", windowName: "yd-patient-flow-oracle" }];

    await cmdAttach("yd-patient-flow");

    expect(tmuxAttachCalls).toEqual(["01-yd-patient-flow:yd-patient-flow-oracle"]);
    expect(logs.join("\n")).toContain("attaching to 01-yd-patient-flow:yd-patient-flow-oracle");
  });

  test("opens a shell split at the live oracle repo without attaching to claude", async () => {
    fleet = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    resolveQueue = [{ tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true });

    expect(spawnCalls).toEqual([[
      "tmux",
      "split-window",
      "-t",
      "50-mawjs:mawjs-oracle",
      "-h",
      "-l",
      "50%",
      expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
    ]]);
    expect(spawnCalls[0][7]).toContain("cd '");
    expect(spawnCalls[0][7]).toContain("exec ");
    expect(logs.join("\n")).toContain("split shell pane");
    expect(logs.join("\n")).toContain("50-mawjs:mawjs-oracle-shell");
  });

  test("dry-runs shell plans and falls back to split when Claude-like pane probing fails", async () => {
    fleet = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    resolveQueue = [{ tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true, dryRun: true });

    expect(logs.join("\n")).toContain("[dry-run] shell — would open split shell pane in 50-mawjs");
    expect(spawnCalls).toEqual([]);

    logs = [];
    process.env.TMUX_PANE = "%42";
    spawnThrowsOnPipe = true;
    resolveQueue = [{ tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true });

    expect(spawnCalls[0]).toEqual(["tmux", "display-message", "-p", "-t", "%42", "#{pane_current_command}"]);
    expect(spawnCalls[1]).toEqual([
      "tmux",
      "split-window",
      "-t",
      "50-mawjs:mawjs-oracle",
      "-h",
      "-l",
      "50%",
      expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
    ]);
    expect(logs.join("\n")).toContain("split shell pane");
  });

  test("--shell --no-split opens a named shell window in the target session", async () => {
    fleet = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    resolveQueue = [{ tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true, split: false });

    expect(spawnCalls).toEqual([[
      "tmux",
      "new-window",
      "-t",
      "50-mawjs:",
      "-n",
      "mawjs-oracle-shell",
      expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
    ]]);
    expect(logs.join("\n")).toContain("opened shell window");
  });

  test("Claude-like callers use a background shell window instead of a split", async () => {
    process.env.TMUX_PANE = "%42";
    spawnStdout = "claude";
    fleet = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    resolveQueue = [{ tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true });

    expect(spawnCalls[0]).toEqual(["tmux", "display-message", "-p", "-t", "%42", "#{pane_current_command}"]);
    expect(spawnCalls[1]).toEqual([
      "tmux",
      "new-window",
      "-t",
      "50-mawjs:",
      "-n",
      "mawjs-oracle-shell",
      expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
    ]);
    expect(logs.join("\n")).toContain("Claude-like caller detected");
  });

  test("handles Tier 2 dry-run and non-interactive yes wake plus attach", async () => {
    resolveQueue = [{ tier: 2, fleetName: "sleepy" }];
    await cmdAttach("sleepy", { dryRun: true });
    expect(logs.join("\n")).toContain("[dry-run] Tier 2 (sleeping) — would wake sleepy, then attach");
    expect(spawnCalls).toEqual([]);

    logs = [];
    resolveQueue = [{ tier: 2, fleetName: "sleepy" }];
    await cmdAttach("sleepy", { yes: true });
    expect(spawnCalls).toEqual([["maw", "wake", "sleepy"]]);
    expect(tmuxAttachCalls).toEqual(["sleepy"]);
    expect(logs.join("\n")).toContain("waking sleepy");
    expect(logs.join("\n")).toContain("attaching to sleepy");
  });

  test("opens shell after wake-created and sleeping fleet sessions", async () => {
    fleet = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    resolveQueue = [null, { tier: 1, sessionName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true });

    expect(resolveCalls).toEqual([
      // #1911 — both passes opt in to preferOracleWindow.
      expect.objectContaining({ target: "mawjs-oracle", opts: { federation: true, preferOracleWindow: true } }),
      expect.objectContaining({ target: "mawjs-oracle", opts: { fuzzy: true, preferOracleWindow: true } }),
    ]);
    expect(spawnCalls).toEqual([
      ["maw", "wake", "mawjs-oracle"],
      [
        "tmux",
        "split-window",
        "-t",
        "50-mawjs:mawjs-oracle",
        "-h",
        "-l",
        "50%",
        expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
      ],
    ]);

    logs = [];
    spawnCalls = [];
    resolveQueue = [{ tier: 2, fleetName: "50-mawjs" }];

    await cmdAttach("mawjs-oracle", { shell: true, yes: true });

    expect(spawnCalls).toEqual([
      ["maw", "wake", "50-mawjs"],
      [
        "tmux",
        "split-window",
        "-t",
        "50-mawjs:mawjs-oracle",
        "-h",
        "-l",
        "50%",
        expect.stringContaining("Soul-Brews-Studio/mawjs-oracle"),
      ],
    ]);
    expect(logs.join("\n")).toContain("waking 50-mawjs");
  });

  test("buildAttachShellPlan falls back to @maw_new_cwd for workspace sessions (#1916 MED-4)", async () => {
    const { buildAttachShellPlan } = await import(`${attachRoot}/impl.ts`);

    // Workspace session has no fleet entry. With @maw_new_cwd set, plan uses it.
    const plan = buildAttachShellPlan("taster", "taster", [], {
      readSessionOption: (session: string, option: string) => {
        if (session === "taster" && option === "@maw_new_cwd") return "/tmp/work";
        return undefined;
      },
    });
    expect(plan.sessionName).toBe("taster");
    expect(plan.cwd).toBe("/tmp/work");
    expect(plan.command).toContain("cd '/tmp/work'");
    expect(plan.windowName).toContain("-shell");
  });

  test("buildAttachShellPlan still throws with actionable hint when no fleet and no @maw_new_cwd", async () => {
    const { buildAttachShellPlan } = await import(`${attachRoot}/impl.ts`);

    expect(() => buildAttachShellPlan("orphan", "orphan", [], {
      readSessionOption: () => undefined,
    })).toThrow(/no oracle entry and no @maw_new_cwd set/);
  });
});
