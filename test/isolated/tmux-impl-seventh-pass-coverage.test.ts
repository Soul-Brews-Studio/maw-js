import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-seventh-pass";

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number; source?: string };

let hostCalls: string[] = [];
let hostFailures: string[] = [];
let hostResponses: Map<string, string> = new Map();
let panes: Pane[] = [];
let fleetEntries: any[] = [];
let ghqRepos: string[] = [];
let ghqThrows = false;
let worktrees: any[] = [];
let worktreesThrow = false;
let tmuxSessionsStdout = "";
let tmuxCaptureOutput = "";
let spawnCalls: Array<{ args: unknown[]; opts?: unknown }> = [];
let spawnExitCode = 0;
let ttyReadText = "";
let existingPaths: Set<string> = new Set();
let dirEntries: Map<string, string[]> = new Map();
let fileContents: Map<string, string> = new Map();

mock.module("os", () => ({ homedir: () => mockHome }));

mock.module("fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string) => dirEntries.get(path) ?? [],
  readFileSync: (path: string) => {
    const text = fileContents.get(path);
    if (text === undefined) throw new Error(`missing fixture: ${path}`);
    return text;
  },
  openSync: () => 44,
  readSync: (_fd: number, buffer: Buffer) => {
    buffer.write(ttyReadText);
    return Buffer.byteLength(ttyReadText);
  },
  closeSync: () => undefined,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostCalls.push(cmd);
    if (hostFailures.some(needle => cmd.includes(needle))) throw new Error(`host failure for ${cmd}`);
    for (const [needle, value] of hostResponses) {
      if (cmd.includes(needle)) return value;
    }
    return "";
  },
  tmux: {
    listPanes: async () => panes,
    capture: async () => tmuxCaptureOutput,
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetEntries,
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqListSync: () => { if (ghqThrows) throw new Error("ghq unavailable"); return ghqRepos; },
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => {
    if (worktreesThrow) throw new Error("scan failed");
    return worktrees;
  },
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
  resolveTmuxTarget,
} = impl;

const original = {
  log: console.log,
  warn: console.warn,
  write: process.stdout.write,
  exit: process.exit,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
  tty: impl._tty.isStdoutTTY,
  readChoice: impl._tty.readChoice,
};

function spawnResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    success: exitCode === 0,
  };
}

function installExitThrow() {
  const exits: number[] = [];
  (process as any).exit = (code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`process.exit:${code ?? 0}`);
  };
  return exits;
}

async function capture(fn: () => void | Promise<void>) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const writes: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    process.stdout.write = original.write;
  }
  return { logs: logs.join("\n"), warnings: warnings.join("\n"), writes: writes.join("") };
}

beforeEach(() => {
  hostCalls = [];
  hostFailures = [];
  hostResponses = new Map();
  panes = [];
  fleetEntries = [];
  ghqRepos = [];
  ghqThrows = false;
  worktrees = [];
  worktreesThrow = false;
  tmuxSessionsStdout = "";
  spawnCalls = [];
  spawnExitCode = 0;
  ttyReadText = "";
  tmuxCaptureOutput = "";
  existingPaths = new Set();
  dirEntries = new Map();
  fileContents = new Map();
  delete process.env.TMUX;
  _sendTracker.clear();
  impl._tty.isStdoutTTY = original.tty;
  impl._tty.readChoice = original.readChoice;
  (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult(tmuxSessionsStdout, 0);
    }
    spawnCalls.push({ args, opts });
    return spawnResult("", spawnExitCode);
  };
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  process.stdout.write = original.write;
  (process as any).exit = original.exit;
  (Bun as any).spawnSync = original.spawnSync;
  impl._tty.isStdoutTTY = original.tty;
  impl._tty.readChoice = original.readChoice;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl seventh-pass targeted coverage", () => {
  test("resolves live tmux sessions by exact names", () => {
    tmuxSessionsStdout = "123-alpha\n456-beta-worker\n";

    expect(resolveTmuxTarget("123-alpha")).toEqual({
      resolved: "123-alpha",
      source: "live-session (123-alpha)",
    });
  });


  test("resolves fleet session suffixes and handles missing ghq during stale fleet recovery", async () => {
    fleetEntries = [
      { file: "101-pulse.json", session: { windows: [] } },
      { file: "202-other.json", session: { windows: [{ name: "other-oracle", repo: "Soul-Brews-Studio/other-oracle" }] } },
    ];
    expect(resolveTmuxTarget("pulse")).toEqual({
      resolved: "101-pulse",
      source: "fleet-stem (101-pulse)",
    });

    impl._tty.isStdoutTTY = () => false;
    ghqThrows = true;
    const exits = installExitThrow();
    const out = await capture(() => {
      expect(() => cmdTmuxAttach("other")).toThrow("process.exit:0");
    });
    expect(out.logs).toContain("202-other matched but not running");
    expect(out.logs).toContain("other-oracle (not cloned)");
    expect(exits).toEqual([0]);
  });

  test("surfaces tmux command failures for peek, send, split, layout, and kill", async () => {
    hostFailures = ["capture-pane"];
    await expect(cmdTmuxPeek("%7")).rejects.toThrow(/tmux capture-pane failed/);

    hostFailures = ["pane_current_command"];
    await expect(cmdTmuxSend("%7", "echo hi")).rejects.toThrow(/pane lookup failed/);

    hostFailures = ["send-keys"];
    await expect(cmdTmuxSend("%8", "echo hi")).rejects.toThrow(/send-keys failed/);

    hostFailures = ["split-window"];
    await expect(cmdTmuxSplit("%9", { cmd: "echo 'quoted'" })).rejects.toThrow(/split-window failed/);

    hostFailures = ["select-layout"];
    await expect(cmdTmuxLayout("demo:1.2", "tiled")).rejects.toThrow(/select-layout failed/);

    hostFailures = ["kill-pane"];
    await expect(cmdTmuxKill("%10")).rejects.toThrow(/kill failed/);
  });

  test("covers send usage, destructive allow, quota throttle, and success flags", async () => {
    await expect(cmdTmuxSend("%1", "")).rejects.toThrow(/usage: maw tmux send/);
    await expect(cmdTmuxSend("%1", "rm -rf /tmp/nope")).rejects.toThrow(/refusing to send/);

    const now = Date.now();
    _sendTracker.set("%1", { lastTs: now - 10_000, count: 100, windowStart: now });
    const quota = await capture(() => cmdTmuxSend("%1", "echo throttled"));
    expect(quota.warnings).toContain("quota");
    expect(hostCalls).toHaveLength(0);

    _sendTracker.set("%1", { lastTs: now - 70_000, count: 100, windowStart: now - 70_000 });
    const success = await capture(() => cmdTmuxSend("%1", "rm -rf /tmp/ok", { allowDestructive: true }));
    expect(success.logs).toContain("destructive-allowed");
    expect(hostCalls.at(-1)).toBe("tmux send-keys -t '%1' 'rm -rf /tmp/ok' Enter");
  });

  test("kills panes resolved from orphan pane titles and reports ambiguous natural names", async () => {
    hostResponses.set("list-panes", "%11|||scratch:0.0|||lonely|||role-a|||/tmp/repo.wt-7-alpha\n");
    const killed = await capture(() => cmdTmuxKill("lonely"));
    expect(hostCalls).toContain("tmux kill-pane -t '%11'");
    expect(killed.logs).toContain("pane-title (lonely)");

    hostCalls = [];
    hostResponses.set("list-panes", "%11|||scratch:0.0|||same|||role-a|||/tmp/a\n%12|||other:0.0|||same|||role-b|||/tmp/b\n");
    await expect(cmdTmuxKill("same")).rejects.toThrow(/ambiguous/);
    expect(hostCalls.some(cmd => cmd.includes("kill-pane"))).toBe(false);
  });

  test("renders compact rosters, frozen context markers, worktrees, and empty-scope messages", async () => {
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "active:0.0", command: "node", title: "node", lastActivity: now - 10 },
      { id: "%2", target: "idle:0.0", command: "bash", title: "idle", lastActivity: now - 120 },
      { id: "%3", target: "stale:0.0", command: "claude", title: "stale", lastActivity: now - 500 },
    ];
    ghqRepos = ["/opt/Code/github.com/Soul-Brews-Studio/sleeping-oracle"];
    worktrees = [{ mainRepo: "/opt/Code/github.com/Soul-Brews-Studio/active", name: "active.wt-1-review", status: "orphan" }];
    tmuxCaptureOutput = "Context limit reached. Run /compact or /clear to continue";

    const compact = await capture(() => cmdTmuxLs({ all: true, compact: true, roster: true, verify: true }));
    expect(compact.logs).toContain("active");
    expect(compact.logs).toContain("context-limit");
    expect(compact.logs).toContain("active.wt-1-review");
    expect(compact.logs).toContain("sleeping-oracle");

    panes = [];
    const emptyAll = await capture(() => cmdTmuxLs({ all: true }));
    expect(emptyAll.logs).toContain("No panes found");

    process.env.TMUX = "/tmp/tmux,1,0";
    hostResponses.set("session_name", "current\n");
    const emptyCurrent = await capture(() => cmdTmuxLs());
    expect(emptyCurrent.logs).toContain("No panes in current session 'current'");
  });

  test("attach recovery auto-wakes one candidate and TTY-selects among many", async () => {
    impl._tty.isStdoutTTY = () => false;
    ghqRepos = ["/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle"];
    spawnExitCode = 7;
    let exits = installExitThrow();
    await capture(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:7");
    });
    expect(spawnCalls.at(-1)).toEqual({
      args: ["maw", "wake", "Soul-Brews-Studio/pulse-oracle", "-a"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    });
    expect(exits).toEqual([7]);

    (process as any).exit = original.exit;
    spawnCalls = [];
    impl._tty.isStdoutTTY = () => true;
    impl._tty.readChoice = () => 2;
    ghqRepos = [
      "/opt/Code/github.com/first/pulse-oracle",
      "/opt/Code/github.com/second/pulse-oracle",
    ];
    spawnExitCode = 0;
    ttyReadText = "2\n";
    exits = installExitThrow();
    const selected = await capture(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:0");
    });
    expect(selected.logs).toContain("Wake which oracle?");
    expect(spawnCalls.at(-1)).toEqual({
      args: ["maw", "wake", "second/pulse-oracle", "-a"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    });
    expect(exits).toEqual([0]);
  });
});
