import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-fifth-pass";

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let panes: Pane[] = [];
let hostCalls: string[] = [];
let hostResponses = new Map<string, string>();
let hostFailures = new Map<string, Error>();
let fleetFiles: string[] = [];
let ghqRepos: string[] = [];
let worktrees: any[] = [];
let spawnCalls: Array<{ args: unknown[]; opts?: unknown }> = [];
let tmuxSessionsStdout = "";
let nextSpawnExitCode = 0;
let tty = false;
let ttyReadText = "";
let contextLimitedTargets = new Set<string>();

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => [],
  readFileSync: () => { throw new Error("unexpected readFileSync"); },
  openSync: () => 42,
  readSync: (_fd: number, buffer: Buffer) => {
    buffer.write(ttyReadText);
    return Buffer.byteLength(ttyReadText);
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
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return "";
    return "";
  },
  tmux: {
    listPanes: async () => panes,
    capture: async (target: string) => contextLimitedTargets.has(target) ? "Context limit reached. /compact or /clear to continue" : "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetFiles.map(file => ({ file })),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqListSync: () => ghqRepos,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => worktrees,
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const {
  _sendTracker,
  cmdTmuxAttach,
  cmdTmuxKill,
  cmdTmuxLs,
  cmdTmuxSend,
  cmdTmuxSplit,
} = impl;

const original = {
  log: console.log,
  warn: console.warn,
  write: process.stdout.write,
  exit: process.exit,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
  dateNow: Date.now,
  tty: impl._tty.isStdoutTTY,
};

function spawnResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    success: exitCode === 0,
  };
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

function installProcessExitThrow() {
  const exits: number[] = [];
  (process as any).exit = (code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`process.exit:${code ?? 0}`);
  };
  return exits;
}

beforeEach(() => {
  panes = [];
  hostCalls = [];
  hostResponses = new Map();
  hostFailures = new Map();
  fleetFiles = [];
  ghqRepos = [];
  worktrees = [];
  spawnCalls = [];
  tmuxSessionsStdout = "";
  nextSpawnExitCode = 0;
  tty = false;
  ttyReadText = "";
  contextLimitedTargets = new Set();
  _sendTracker.clear();
  delete process.env.TMUX;
  Date.now = original.dateNow;
  impl._tty.isStdoutTTY = () => tty;
  (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult(tmuxSessionsStdout, 0);
    }
    spawnCalls.push({ args, opts });
    return spawnResult("", nextSpawnExitCode);
  };
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  process.stdout.write = original.write;
  (process as any).exit = original.exit;
  (Bun as any).spawnSync = original.spawnSync;
  Date.now = original.dateNow;
  impl._tty.isStdoutTTY = original.tty;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl fifth-pass isolated branch coverage", () => {
  test("compact recent ls renders created ordering, frozen context-limit panes, non-active worktree labels, and sleeping totals", async () => {
    Date.now = () => 1_700_000_000_000;
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "new-session:0.0", command: "claude", title: "frozen agent", lastActivity: now - 5 },
      { id: "%2", target: "old-session:0.0", command: "zsh", title: "plain shell", lastActivity: now - 600 },
    ];
    contextLimitedTargets.add("new-session:0.0");
    hostResponses.set("session_created", "old-session\t100\nnew-session\t200\n");
    worktrees = [
      { mainRepo: "/opt/Code/new-session", name: "new-session.wt-orphan", status: "orphan" },
    ];
    ghqRepos = [
      "/opt/Code/github.com/Soul-Brews-Studio/new-session-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/sleeping-friend-oracle",
    ];

    const { logs } = await capture(() => cmdTmuxLs({ all: true, compact: true, recent: true, roster: true, verify: true }));

    expect(logs).toContain("SESSION");
    expect(logs).toContain("CREATED");
    expect(logs.indexOf("new-session")).toBeLessThan(logs.indexOf("old-session"));
    expect(logs).toContain("context-limit — /compact needed");
    expect(logs).toContain("new-session.wt-orphan");
    expect(logs).toContain("(orphan)");
    expect(logs).toContain("sleeping-friend-oracle");
    expect(logs).toContain("oracles —");
  });

  test("send refuses claude-like panes and cooldown throttles repeated unforced sends", async () => {
    hostResponses.set("pane_current_command", "2.1.111\n");
    await expect(cmdTmuxSend("%9", "echo hi")).rejects.toThrow("refusing to send: pane '%9' is running '2.1.111'");
    expect(hostCalls.some(c => c.includes("send-keys"))).toBe(false);

    _sendTracker.clear();
    hostResponses.set("pane_current_command", "zsh\n");
    Date.now = () => 9_000_000;
    await capture(() => cmdTmuxSend("%9", "echo first"));
    const throttled = await capture(() => cmdTmuxSend("%9", "echo second"));

    expect(throttled.warnings).toContain("cooldown (500ms)");
    expect(hostCalls.filter(c => c.includes("send-keys"))).toEqual([
      "tmux send-keys -t '%9' 'echo first' Enter",
    ]);
  });

  test("split covers vertical command suffix quoting and kill covers session force path", async () => {
    const split = await capture(() => cmdTmuxSplit("%2", { vertical: true, pct: 33, cmd: "echo 'hello'" }));
    expect(hostCalls.at(-1)).toBe("tmux split-window -v -l 33% -t '%2' 'echo '\\''hello'\\'''");
    expect(split.logs).toContain("vertical 33%");

    hostCalls = [];
    fleetFiles = ["101-fleet.json"];
    await expect(cmdTmuxKill("101-fleet:0.0", { session: true })).rejects.toThrow("refusing to kill: session '101-fleet' is fleet or view");

    const killed = await capture(() => cmdTmuxKill("101-fleet:0.0", { session: true, force: true }));
    expect(hostCalls.at(-1)).toBe("tmux kill-session -t '101-fleet'");
    expect(killed.logs).toContain("killed session");
    expect(killed.logs).toContain("(force)");
  });

  test("attach recovery exits when no candidates and live TTY attach chooses attach or switch-client", async () => {
    const noCandidateExits = installProcessExitThrow();
    await capture(() => {
      expect(() => cmdTmuxAttach("missing")).toThrow("process.exit:1");
    });
    expect(noCandidateExits).toEqual([1]);

    (process as any).exit = original.exit;
    tty = true;
    tmuxSessionsStdout = "live\n";

    await capture(() => cmdTmuxAttach("live"));
    expect(spawnCalls.at(-1)).toEqual({
      args: ["tmux", "attach", "-t", "live"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    });

    process.env.TMUX = "/tmp/tmux,1,0";
    await capture(() => cmdTmuxAttach("live"));
    expect(spawnCalls.at(-1)).toEqual({
      args: ["tmux", "switch-client", "-t", "live"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    });
  });
});
