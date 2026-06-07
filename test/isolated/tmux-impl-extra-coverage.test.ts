import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-extra";
const teamsRoot = `${mockHome}/.claude/teams`;

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let existingPaths: Set<string> = new Set();
let dirEntries: Map<string, string[]> = new Map();
let fileContents: Map<string, string> = new Map();
let ttyInput = "1\n";
let hostCalls: string[] = [];
let hostFailures = new Map<string, Error>();
let hostResponses = new Map<string, string>();
let panes: Pane[] = [];
let fleetFiles: string[] = [];
let fleetWindows: Record<string, string[]> = {};
let ghqRepos: string[] = [];
let ghqSyncThrows = false;
let worktrees: any[] = [];
let tmuxCaptures = new Map<string, string>();

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string) => dirEntries.get(path) ?? [],
  readFileSync: (path: string) => {
    const text = fileContents.get(path);
    if (text === undefined) throw new Error(`missing fixture: ${path}`);
    return text;
  },
  openSync: () => 42,
  readSync: (_fd: number, buffer: Buffer) => {
    buffer.write(ttyInput);
    return Buffer.byteLength(ttyInput);
  },
  closeSync: () => undefined,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostCalls.push(cmd);
    for (const [needle, err] of hostFailures) {
      if (cmd.includes(needle)) throw err;
    }
    for (const [needle, value] of hostResponses) {
      if (cmd.includes(needle)) return value;
    }
    if (cmd.includes("pane_current_command")) return "zsh\n";
    if (cmd.includes("list-panes -a -F")) return "";
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "current-session\n";
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return "";
    if (cmd.includes("capture-pane")) return "captured\n";
    return "";
  },
  tmux: {
    listPanes: async () => panes,
    capture: async (target: string) => tmuxCaptures.get(target) ?? "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetFiles.map(file => {
    const sessionName = file.replace(/\.json$/, "");
    const windows = fleetWindows[file] ?? [sessionName];
    return {
      file,
      session: {
        windows: windows.map(name => ({ name, repo: `Org/${name.endsWith("-oracle") ? name : `${name}-oracle`}` })),
      },
    };
  }),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqListSync: () => {
    if (ghqSyncThrows) throw new Error("ghq unavailable");
    return ghqRepos;
  },
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => worktrees,
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const {
  _sendTracker,
  cmdTmuxAttach,
  cmdTmuxKill,
  cmdTmuxLayout,
  cmdTmuxLs,
  cmdTmuxPeek,
  cmdTmuxSend,
  cmdTmuxSplit,
  annotatePane,
  formatSessionCreated,
  parseSessionCreatedList,
  resolveTmuxTarget,
  similarOracleCandidatesFromRepos,
} = impl;

const original = {
  log: console.log,
  warn: console.warn,
  exit: process.exit,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
  dateNow: Date.now,
  tty: impl._tty.isStdoutTTY,
};

async function capture(fn: () => void | Promise<void>) {
  const logs: string[] = [];
  const warnings: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
  return { logs: logs.join("\n"), warnings: warnings.join("\n") };
}

function installProcessExitThrow() {
  const exits: number[] = [];
  (process as any).exit = (code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`process.exit:${code ?? 0}`);
  };
  return exits;
}

beforeEach(() => {
  existingPaths = new Set();
  dirEntries = new Map();
  fileContents = new Map();
  ttyInput = "1\n";
  hostCalls = [];
  hostFailures = new Map();
  hostResponses = new Map();
  panes = [];
  fleetFiles = [];
  fleetWindows = {};
  ghqRepos = [];
  ghqSyncThrows = false;
  worktrees = [];
  tmuxCaptures = new Map();
  _sendTracker.clear();
  delete process.env.TMUX;
  Date.now = original.dateNow;
  (Bun as any).spawnSync = (args: unknown[]) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return { exitCode: 0, stdout: new TextEncoder().encode(""), stderr: new Uint8Array(), success: true };
    }
    return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
  };
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  (process as any).exit = original.exit;
  (Bun as any).spawnSync = original.spawnSync;
  Date.now = original.dateNow;
  impl._tty.isStdoutTTY = original.tty;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl extra coverage", () => {
  test("real tty helpers and resolver direct/team/exact/live branches run in one isolated process", () => {
    expect(typeof impl._tty.isStdoutTTY()).toBe("boolean");

    expect(resolveTmuxTarget("%123")).toEqual({ resolved: "%123", source: "pane-id" });
    expect(resolveTmuxTarget("alpha:2.3")).toEqual({ resolved: "alpha:2.3", source: "session:w.p" });

    existingPaths.add(teamsRoot);
    dirEntries.set(teamsRoot, ["blue-team", "broken-team"]);
    existingPaths.add(`${teamsRoot}/blue-team/config.json`);
    existingPaths.add(`${teamsRoot}/broken-team/config.json`);
    fileContents.set(`${teamsRoot}/blue-team/config.json`, JSON.stringify({
      members: [
        { name: "ignored", tmuxPaneId: "in-process" },
        { name: "scout", tmuxPaneId: "%77" },
      ],
    }));
    fileContents.set(`${teamsRoot}/broken-team/config.json`, "{not json");
    expect(resolveTmuxTarget("scout")).toEqual({ resolved: "%77", source: "team-agent (blue-team)" });
    expect(resolveTmuxTarget("ghost")).toEqual({ resolved: "ghost", source: "session-name" });

    existingPaths.clear();
    fleetFiles = ["22-alpha.json", "41-beta-worker.json"];
    expect(resolveTmuxTarget("22-alpha")).toEqual({ resolved: "22-alpha", source: "fleet-stem (22-alpha)" });
    expect(resolveTmuxTarget("worker")).toEqual({ resolved: "41-beta-worker", source: "fleet-stem (41-beta-worker)" });

    fleetFiles = [];
    (Bun as any).spawnSync = (args: unknown[]) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("live-alpha\n33-live-beta\n"),
          stderr: new Uint8Array(),
          success: true,
        };
      }
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    };
    expect(resolveTmuxTarget("live-alpha")).toEqual({ resolved: "live-alpha", source: "live-session (live-alpha)" });
    expect(resolveTmuxTarget("nomatch")).toEqual({ resolved: "nomatch", source: "session-name" });
    expect(resolveTmuxTarget("beta")).toEqual({ resolved: "33-live-beta", source: "live-session (33-live-beta)" });
  });

  test("kill/list/attach fallback callbacks handle failed lookups and sleeping roster filters", async () => {
    hostFailures.set("list-panes -a -F", new Error("pane list failed"));
    await capture(() => cmdTmuxKill("scratch", { force: true }));
    expect(hostCalls.some(cmd => cmd.includes("kill-pane -t 'scratch'"))).toBe(true);

    hostFailures = new Map([["session_created", new Error("created lookup failed")]]);
    panes = [{ id: "%1", target: "alpha:0.0", command: "zsh", title: "shell", lastActivity: Math.floor(Date.now() / 1000) - 1 }];
    const recent = await capture(() => cmdTmuxLs({ all: true, recent: true }));
    expect(recent.logs).toContain("alpha:0.0");

    hostFailures = new Map([["display-message", new Error("current session failed")]]);
    process.env.TMUX = "/tmp/tmux,1,2";
    panes = [{ id: "%2", target: "current:0.0", command: "zsh", title: "shell" }];
    const scoped = await capture(() => cmdTmuxLs({}));
    expect(scoped.logs).toContain("No panes in current session");

    hostFailures = new Map();
    delete process.env.TMUX;
    panes = [{ id: "%3", target: "awake-oracle:0.0", command: "node", title: "agent" }];
    ghqRepos = ["/repos/awake-oracle", "/repos/sleeping-oracle", "/repos/not-oracle.txt"];
    const roster = await capture(() => cmdTmuxLs({ all: true, compact: true, roster: true }));
    expect(roster.logs).toContain("sleeping-oracle");

    impl._tty.isStdoutTTY = () => true;
    impl._tty.readChoice = () => { throw new Error("tty closed"); };
    ghqRepos = ["/repos/one-oracle", "/repos/two-oracle"];
    const exits = installProcessExitThrow();
    await capture(() => {
      expect(() => cmdTmuxAttach("oracle")).toThrow("process.exit:1");
    });
    expect(exits).toEqual([1]);
  });

  test("resolveTmuxTarget accepts unique same-word numbered fleet shorthand (#1794)", () => {
    fleetFiles = ["20-homekeeper.json"];
    expect(resolveTmuxTarget("homeke")).toEqual({
      resolved: "20-homekeeper",
      source: "fleet-stem (20-homekeeper)",
    });

    fleetFiles = ["114-mawjs-no2.json"];
    expect(resolveTmuxTarget("mawjs")).toEqual({
      resolved: "mawjs",
      source: "session-name",
    });
  });


  test("resolveTmuxTarget resolves fleet window aliases for role-suffixed sessions", () => {
    fleetFiles = ["23-discord-admin.json", "114-mawjs-no2.json"];
    fleetWindows = {
      "23-discord-admin.json": ["discord-oracle"],
      "114-mawjs-no2.json": ["mawjs-no2"],
    };

    expect(resolveTmuxTarget("discord-oracle")).toEqual({
      resolved: "23-discord-admin",
      source: "fleet-window (23-discord-admin)",
    });
    expect(resolveTmuxTarget("discord")).toEqual({
      resolved: "23-discord-admin",
      source: "fleet-window (23-discord-admin)",
    });
    expect(resolveTmuxTarget("mawjs")).toEqual({
      resolved: "mawjs",
      source: "session-name",
    });
  });

  test("resolveTmuxTarget accepts unique same-word live-session shorthand (#1794)", () => {
    (Bun as any).spawnSync = (args: unknown[]) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("20-homekeeper\n"),
          stderr: new Uint8Array(),
          success: true,
        };
      }
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    };

    expect(resolveTmuxTarget("homeke")).toEqual({
      resolved: "20-homekeeper",
      source: "live-session (20-homekeeper)",
    });
  });

  test("ls reports empty current-session and all-session states", async () => {
    const current = await capture(() => cmdTmuxLs());
    expect(current.logs).toContain("No panes in current session '(none)'");

    const all = await capture(() => cmdTmuxLs({ all: true }));
    expect(all.logs).toContain("No panes found");
  });

  test("compact ls renders stale status, worktrees, roster sleeping summary, and current-session filtering", async () => {
    process.env.TMUX = "/tmp/tmux,1,0";
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "current-session:0.0", command: "node", title: "agent", lastActivity: now - 400 },
      { id: "%2", target: "other-session:0.0", command: "zsh", title: "other", lastActivity: now },
    ];
    worktrees = [
      { mainRepo: "/opt/Code/current-session", name: "current-session.wt-1-scout", status: "active" },
      { mainRepo: "/opt/Code/current-session", name: "current-session.wt-2-old", status: "stale" },
    ];
    tmuxCaptures.set("current-session:0.0", "Context limit reached. /compact or /clear to continue.");
    ghqRepos = [
      "/opt/Code/github.com/Soul-Brews-Studio/current-session-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/sleepy-oracle",
    ];

    const { logs } = await capture(() => cmdTmuxLs({ compact: true, roster: true, verify: true }));

    expect(logs).toContain("current-session");
    expect(logs).not.toContain("other-session");
    expect(logs).toContain("current-session.wt-1-scout");
    expect(logs).toContain("worktree");
    expect(logs).toContain("current-session.wt-2-old");
    expect(logs).toContain("stale");
    expect(logs).toContain("sleepy-oracle");
    expect(logs).toContain("sleeping");
  });

  test("ls renders recent verbose detail and hides infrastructure channel sessions by default", async () => {
    Date.now = () => 2_000_000_000_000;
    const now = Math.floor(Date.now() / 1000);
    fleetFiles = ["11-fleet-session.json"];
    panes = [
      { id: "%1", target: "11-fleet-session:0.0", command: "node", title: "fleet pane", lastActivity: now - 10 },
      { id: "%2", target: "maw-view:0.0", command: "zsh", title: "view pane", lastActivity: now - 70 },
      { id: "%3", target: "orphan:0.0", command: "claude", title: "orphan pane", lastActivity: now - 3700 },
      { id: "%4", target: "plain:0.0", command: "fish", title: "plain pane" },
      { id: "%5", target: "mawjs-oracle-discord:0.0", command: "claude", title: "channel pane", lastActivity: now - 5 },
    ];
    tmuxCaptures.set("11-fleet-session:0.0", "Context limit reached. /compact or /clear to continue.");
    hostResponses.set(
      "list-sessions -F",
      [
        "orphan\t1999990000",
        "maw-view\t1999999900",
        "11-fleet-session\t1999999990",
        "plain\t1999999800",
        "mawjs-oracle-discord\t1999999999",
      ].join("\n"),
    );

    const { logs } = await capture(() => cmdTmuxLs({ all: true, verbose: true, recent: true }));

    expect(logs).toContain("CREATED");
    expect(logs).toContain("11-fleet-session:0.0");
    expect(logs).toContain("context-limit");
    expect(logs).toContain("fleet: fleet-session");
    expect(logs).toContain("view: maw-view");
    expect(logs).toContain("orphan");
    expect(logs).toContain("1h1m");
    expect(logs).not.toContain("mawjs-oracle-discord");
  });

  test("ls supports recent compact limiting, filtered JSON, and explicit channel visibility", async () => {
    Date.now = () => 2_000_000_000_000;
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "newest:0.0", command: "node", title: "new", lastActivity: now - 10 },
      { id: "%2", target: "middle:0.0", command: "zsh", title: "middle", lastActivity: now - 600 },
      { id: "%3", target: "oldest:0.0", command: "fish", title: "old", lastActivity: now - 600 },
      { id: "%4", target: "bridge-oracle-discord:0.0", command: "claude", title: "channel", lastActivity: now - 1 },
    ];
    worktrees = [
      { mainRepo: "/opt/Code/newest", name: "newest.wt-1-active", status: "active" },
      { mainRepo: "/opt/Code/middle", name: "middle.wt-2-orphan", status: "orphan" },
    ];
    hostResponses.set(
      "list-sessions -F",
      [
        "oldest\t1999990000",
        "middle\t1999999000",
        "newest\t1999999999",
        "bridge-oracle-discord\t1999999998",
      ].join("\n"),
    );

    const compact = await capture(() => cmdTmuxLs({ all: true, compact: true, recent: true, recentLimit: 2, verify: true }));
    expect(compact.logs).toContain("SESSION");
    expect(compact.logs).toContain("newest");
    expect(compact.logs).toContain("middle");
    expect(compact.logs).not.toContain("oldest");
    expect(compact.logs).not.toContain("bridge-oracle-discord");
    expect(compact.logs).toContain("newest.wt-1-active");
    expect(compact.logs).toContain("middle.wt-2-orphan");

    const json = await capture(() => cmdTmuxLs({ all: true, json: true, filter: "discord", channels: true }));
    expect(JSON.parse(json.logs)).toMatchObject([
      { session: "bridge-oracle-discord" },
    ]);
  });

  test("ls reads team configs for pane annotations in the listing path", async () => {
    existingPaths.add(teamsRoot);
    existingPaths.add(`${teamsRoot}/ops/config.json`);
    dirEntries.set(teamsRoot, ["ops"]);
    fileContents.set(`${teamsRoot}/ops/config.json`, JSON.stringify({
      members: [
        { name: "lead", tmuxPaneId: "%44" },
        { name: "local", tmuxPaneId: "in-process" },
      ],
    }));
    panes = [
      { id: "%44", target: "ops-session:0.0", command: "zsh", title: "ops", lastActivity: Math.floor(Date.now() / 1000) },
    ];

    const { logs } = await capture(() => cmdTmuxLs({ all: true, json: true }));
    expect(JSON.parse(logs)[0].annotation).toBe("team: lead @ ops");
  });

  test("tmux helpers format sessions, parse creation times, annotate panes, and dedupe similar oracles", () => {
    expect(parseSessionCreatedList("alpha\t123\nbad\t0\nmissing\nbeta\t456\n")).toEqual(new Map([["alpha", 123], ["beta", 456]]));
    expect(formatSessionCreated()).toBe("—");
    expect(formatSessionCreated(Number.NaN)).toBe("—");
    expect(formatSessionCreated(1)).toMatch(/^1970-01-0[1-2] /);
    expect(annotatePane({ id: "%1", target: "session:0.0", command: "zsh" }, new Set(), new Map([["%1", "lead @ team"]]))).toBe("team: lead @ team");
    expect(annotatePane({ id: "%2", target: "10-demo:0.0", command: "zsh" }, new Set(["10-demo"]), new Map())).toBe("fleet: demo");
    expect(annotatePane({ id: "%3", target: "demo-view:0.0", command: "zsh" }, new Set(), new Map())).toBe("view: demo-view");
    expect(annotatePane({ id: "%4", target: "shell:0.0", command: "claude" }, new Set(), new Map())).toBe("orphan");
    expect(annotatePane({ id: "%5", target: "shell:0.0", command: "zsh" }, new Set(), new Map())).toBe("");
    expect(similarOracleCandidatesFromRepos("pulse", [
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/not-pulse",
    ])).toEqual(["Soul-Brews-Studio/pulse-oracle"]);
  });

  test("peek wraps capture-pane failures with target source", async () => {
    const ok = await capture(() => cmdTmuxPeek("%8", { lines: 4 }));
    expect(ok.logs).toContain("%8 → %8 [pane-id]");
    expect(ok.logs).toContain("captured");

    hostFailures.set("capture-pane", new Error("pane gone"));

    await expect(cmdTmuxPeek("%9")).rejects.toThrow("tmux capture-pane failed for '%9' (from pane-id): pane gone");
  });

  test("send validates command, destructive commands, cooldown, claude panes, lookup failures, quota, and send failures", async () => {
    await expect(cmdTmuxSend("%9", "")).rejects.toThrow("usage: maw tmux send");
    await expect(cmdTmuxSend("%9", "rm -rf /tmp/nope")).rejects.toThrow("refusing to send: command matches destructive patterns");
    _sendTracker.clear();

    Date.now = () => 500_000;
    _sendTracker.set("%9", { lastTs: 499_900, count: 1, windowStart: 499_000 });
    const cooldown = await capture(() => cmdTmuxSend("%9", "echo soon"));
    expect(cooldown.warnings).toContain("cooldown (500ms)");
    _sendTracker.clear();

    hostResponses.set("pane_current_command", "claude\n");
    await expect(cmdTmuxSend("%9", "echo hi")).rejects.toThrow("refusing to send: pane '%9' is running 'claude'");
    hostResponses.clear();
    _sendTracker.clear();

    hostFailures.set("pane_current_command", new Error("no pane"));
    await expect(cmdTmuxSend("%9", "echo hi")).rejects.toThrow("pane lookup failed for '%9' (from pane-id): no pane");
    hostFailures.clear();
    _sendTracker.clear();

    Date.now = () => 1_000_000;
    _sendTracker.set("%9", { lastTs: 1_000_000 - 1000, count: 100, windowStart: 1_000_000 - 10_000 });
    const quota = await capture(() => cmdTmuxSend("%9", "echo quota"));
    expect(quota.warnings).toContain("quota (100/min)");
    expect(hostCalls.filter(c => c.includes("send-keys"))).toEqual([]);

    _sendTracker.clear();
    hostFailures.set("send-keys", new Error("send failed"));
    await expect(cmdTmuxSend("%9", "echo hi", { force: true })).rejects.toThrow("send-keys failed for '%9': send failed");
  });

  test("expired send quota window resets and allows sending", async () => {
    Date.now = () => 2_000_000;
    _sendTracker.set("%9", { lastTs: 2_000_000 - 5_000, count: 100, windowStart: 2_000_000 - 70_000 });

    await capture(() => cmdTmuxSend("%9", "echo reset"));

    expect(_sendTracker.get("%9")).toMatchObject({ count: 1, windowStart: 2_000_000 });
    expect(hostCalls.at(-1)).toBe("tmux send-keys -t '%9' 'echo reset' Enter");
  });

  test("split and layout wrap hostExec failures", async () => {
    await expect(cmdTmuxSplit("%9", { pct: 0 })).rejects.toThrow("--pct must be 1-99");
    hostFailures.set("split-window", new Error("split denied"));
    await expect(cmdTmuxSplit("%9")).rejects.toThrow("split-window failed for '%9' (from pane-id): split denied");

    hostFailures.clear();
    await expect(cmdTmuxLayout("%9", "stacked")).rejects.toThrow("invalid layout 'stacked'");
    hostFailures.set("select-layout", new Error("layout denied"));
    await expect(cmdTmuxLayout("demo:1.2", "tiled")).rejects.toThrow("select-layout failed for 'demo:1' (from session:w.p): layout denied");
  });

  test("kill resolves pane aliases, reports ambiguous aliases, protects fleet sessions, and wraps kill failures", async () => {
    fleetFiles = ["42-live-oracle.json"];
    await expect(cmdTmuxKill("42-live-oracle")).rejects.toThrow("refusing to kill: session '42-live-oracle' is fleet or view");
    fleetFiles = [];

    hostResponses.set("list-panes -a -F", "%101|||scratch:0.0|||worker|||tile-a|||/tmp/repo.wt-1-scout\n");
    const ok = await capture(() => cmdTmuxKill("scout"));
    expect(hostCalls).toContain("tmux kill-pane -t '%101'");
    expect(ok.logs).toContain("worktree-role (scout)");

    hostCalls = [];
    hostResponses.set("list-panes -a -F", "%101|||scratch:0.0|||dup|||role|||/tmp/a\n%102|||other:0.0|||dup|||role|||/tmp/b\n");
    await expect(cmdTmuxKill("dup")).rejects.toThrow("'dup' is ambiguous — matches 2 panes");
    expect(hostCalls.some(c => c.includes("kill-pane"))).toBe(false);

    hostCalls = [];
    hostResponses.set("list-panes -a -F", "%101|||scratch:0.0|||worker|||tile-a|||/tmp/repo.wt-1-scout\n");
    hostFailures.set("kill-pane", new Error("kill denied"));
    await expect(cmdTmuxKill("scout")).rejects.toThrow("kill failed for '%101' (from worktree-role (scout)): kill denied");
  });

  test("attach recovery auto-selects a single similar oracle candidate", () => {
    ghqRepos = ["/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle"];
    impl._tty.isStdoutTTY = () => false;
    const logs: string[] = [];
    const exits: number[] = [];
    const spawnCalls: unknown[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    (process as any).exit = (code?: number) => { exits.push(code ?? 0); throw new Error(`exit:${code ?? 0}`); };
    (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return { exitCode: 0, stdout: new TextEncoder().encode(""), stderr: new Uint8Array(), success: true };
      }
      spawnCalls.push({ args, opts });
      return { exitCode: 7, stdout: new Uint8Array(), stderr: new Uint8Array(), success: false };
    };

    expect(() => impl.cmdTmuxAttach("pulse")).toThrow("exit:7");

    expect(logs.join("\n")).toContain("auto-selecting");
    expect(spawnCalls).toEqual([{ args: ["maw", "wake", "Soul-Brews-Studio/pulse-oracle", "-a"], opts: { stdio: ["inherit", "inherit", "inherit"] } }]);
    expect(exits).toEqual([7]);
  });

  test("attach covers print, live attach/switch, stale fleet recovery, and interactive recovery choices", () => {
    const logs: string[] = [];
    const exits: number[] = [];
    const spawnCalls: unknown[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    (process as any).exit = (code?: number) => { exits.push(code ?? 0); throw new Error(`exit:${code ?? 0}`); };
    (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("alpha\n"),
          stderr: new Uint8Array(),
          success: true,
        };
      }
      spawnCalls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    };

    impl._tty.isStdoutTTY = () => false;
    impl.cmdTmuxAttach("alpha", { print: true });
    expect(logs.join("\n")).toContain("tmux attach -t alpha");

    logs.length = 0;
    impl._tty.isStdoutTTY = () => true;
    impl.cmdTmuxAttach("alpha");
    process.env.TMUX = "/tmp/tmux,1,0";
    impl.cmdTmuxAttach("alpha");
    expect(spawnCalls).toContainEqual({ args: ["tmux", "attach", "-t", "alpha"], opts: { stdio: ["inherit", "inherit", "inherit"] } });
    expect(spawnCalls).toContainEqual({ args: ["tmux", "switch-client", "-t", "alpha"], opts: { stdio: ["inherit", "inherit", "inherit"] } });

    delete process.env.TMUX;
    fleetFiles = ["44-sleeping.json"];
    fleetWindows = { "44-sleeping.json": ["sleeping-oracle"] };
    ghqRepos = ["/opt/Code/github.com/Org/sleeping-oracle"];
    (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return { exitCode: 0, stdout: new TextEncoder().encode(""), stderr: new Uint8Array(), success: true };
      }
      spawnCalls.push({ args, opts });
      return { exitCode: 3, stdout: new Uint8Array(), stderr: new Uint8Array(), success: false };
    };
    expect(() => impl.cmdTmuxAttach("44-sleeping")).toThrow("exit:3");
    expect(logs.join("\n")).toContain("sleeping-oracle (cloned)");

    logs.length = 0;
    exits.length = 0;
    ghqRepos = [
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-helper-oracle",
    ];
    impl._tty.isStdoutTTY = () => false;
    expect(() => impl.cmdTmuxAttach("pulse")).toThrow("exit:1");
    expect(logs.join("\n")).toContain("pulse-oracle");
    expect(logs.join("\n")).toContain("pulse-helper-oracle");

    logs.length = 0;
    exits.length = 0;
    impl._tty.isStdoutTTY = () => true;
    impl._tty.readChoice = () => 2;
    (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return { exitCode: 0, stdout: new TextEncoder().encode(""), stderr: new Uint8Array(), success: true };
      }
      spawnCalls.push({ args, opts });
      return { exitCode: 4, stdout: new Uint8Array(), stderr: new Uint8Array(), success: false };
    };
    expect(() => impl.cmdTmuxAttach("pulse")).toThrow("exit:4");
    expect(logs.join("\n")).toContain("Wake which oracle?");
    expect(logs.join("\n")).toContain("maw wake Soul-Brews-Studio/pulse-helper-oracle -a");

    logs.length = 0;
    exits.length = 0;
    impl._tty.readChoice = () => null;
    expect(() => impl.cmdTmuxAttach("pulse")).toThrow("exit:1");
    expect(exits).toEqual([1]);

    logs.length = 0;
    exits.length = 0;
    ghqRepos = [];
    expect(() => impl.cmdTmuxAttach("missing")).toThrow("exit:1");
    expect(logs.join("\n")).toContain("No session matches 'missing'");

    logs.length = 0;
    exits.length = 0;
    fleetFiles = ["55-stale.json"];
    fleetWindows = { "55-stale.json": ["stale-oracle"] };
    ghqSyncThrows = true;
    expect(() => impl.cmdTmuxAttach("55-stale")).toThrow("exit:4");
    expect(logs.join("\n")).toContain("stale-oracle (not cloned)");

    logs.length = 0;
    exits.length = 0;
    fleetFiles = [];
    ghqSyncThrows = false;
    ghqRepos = [];
    impl._tty.isStdoutTTY = () => true;
    (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
      if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
        return { exitCode: 0, stdout: new TextEncoder().encode("alpha\n"), stderr: new Uint8Array(), success: true };
      }
      spawnCalls.push({ args, opts });
      return { exitCode: 5, stdout: new Uint8Array(), stderr: new Uint8Array(), success: false };
    };
    expect(() => impl.cmdTmuxAttach("alpha")).toThrow("exit:1");
    expect(logs.join("\n")).toContain("alpha matched but not running");
  });
});
