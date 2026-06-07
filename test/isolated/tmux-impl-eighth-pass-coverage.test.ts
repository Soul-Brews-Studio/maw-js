import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-eighth-pass";

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number; source?: string; node?: string };

let panes: Pane[] = [];
let fleetEntries: any[] = [];
let ghqRepos: string[] = [];
let hostCalls: string[] = [];
let hostResponses: Map<string, string> = new Map();
let hostFailures: Map<string, Error> = new Map();
let tmuxSessionsStdout = "";
let spawnExitCode = 0;
let spawnCalls: Array<{ args: unknown[]; opts?: unknown }> = [];
let ttyReadText = "";
let ghqListThrows = false;

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
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "current\n";
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return "";
    return "";
  },
  tmux: {
    listPanes: async () => panes,
    capture: async () => "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetEntries,
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => {
    if (ghqListThrows) throw new Error("ghq boom");
    return ghqRepos;
  },
  ghqListSync: () => {
    if (ghqListThrows) throw new Error("ghq boom");
    return ghqRepos;
  },
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
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
  formatSessionCreated,
  parseSessionCreatedList,
  resolveTmuxTarget,
  similarOracleCandidatesFromRepos,
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

function installProcessExitThrow() {
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
  panes = [];
  fleetEntries = [];
  ghqRepos = [];
  hostCalls = [];
  hostResponses = new Map();
  hostFailures = new Map();
  tmuxSessionsStdout = "";
  spawnExitCode = 0;
  spawnCalls = [];
  ttyReadText = "";
  ghqListThrows = false;
  _sendTracker.clear();
  Date.now = original.dateNow;
  impl._tty.isStdoutTTY = original.tty;
  delete process.env.TMUX;
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
  Date.now = original.dateNow;
  impl._tty.isStdoutTTY = original.tty;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl eighth-pass branch coverage", () => {
  test("peek renders default/history captures and wraps capture failures", async () => {
    hostResponses.set("capture-pane", "pane output\n");

    const printed = await capture(async () => {
      await cmdTmuxPeek("%12");
      await cmdTmuxPeek("demo:1.2", { history: true });
    });

    expect(hostCalls[0]).toBe("tmux capture-pane -pt '%12' -S -30 -J");
    expect(hostCalls[1]).toBe("tmux capture-pane -pt 'demo:1.2' -S - -J");
    expect(printed.logs).toContain("%12 → %12 [pane-id]");
    expect(printed.logs).toContain("pane output");

    hostFailures.set("capture-pane", new Error("no pane"));
    await expect(cmdTmuxPeek("%13", { lines: 5 })).rejects.toThrow("tmux capture-pane failed for '%13' (from pane-id): no pane");
  });

  test("ls covers empty scoped output, json filtering by source, channel inclusion, and long age formatting", async () => {
    const emptyCurrent = await capture(() => cmdTmuxLs({}));
    expect(emptyCurrent.logs).toContain("No panes in current session '(none)'. Use --all for every session.");

    const emptyAll = await capture(() => cmdTmuxLs({ all: true }));
    expect(emptyAll.logs).toContain("No panes found.");

    Date.now = () => 1_700_000_000_000;
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "worker:0.0", command: "bash", title: "long title".repeat(8), lastActivity: now - 3_660, source: "node-a" },
      { id: "%2", target: "alerts-discord:0.0", command: "node", title: "infra", lastActivity: now - 5, node: "node-b" },
    ];
    hostResponses.set("session_created", "worker\t1700000000\nalerts-discord\t1700000100\n");

    const json = await capture(() => cmdTmuxLs({ all: true, json: true, filter: "node-a", recent: true }));
    const rows = JSON.parse(json.logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "worker:0.0", source: "node-a" });

    const rendered = await capture(() => cmdTmuxLs({ all: true, channels: true, recent: true }));
    expect(rendered.logs).toContain("alerts-discord:0.0");
    expect(rendered.logs).toContain("worker:0.0");
    expect(rendered.logs).toContain("1h1m");
  });

  test("send covers quota, reset window, destructive bypass, force/literal, and host failures", async () => {
    Date.now = () => 10_000;
    _sendTracker.set("%3", { lastTs: 9_000, count: 100, windowStart: 8_000 });
    const quota = await capture(() => cmdTmuxSend("%3", "echo no"));
    expect(quota.warnings).toContain("quota (100/min)");
    expect(hostCalls).toEqual([]);

    Date.now = () => 70_001;
    hostResponses.set("pane_current_command", "claude\n");
    const forced = await capture(() => cmdTmuxSend("%3", "rm -rf /tmp/nope", { force: true, literal: true, allowDestructive: true }));
    expect(hostCalls.at(-1)).toBe("tmux send-keys -t '%3' 'rm -rf /tmp/nope'");
    expect(forced.logs).toContain("(literal)");
    expect(forced.logs).toContain("(destructive-allowed)");
    expect(forced.logs).toContain("(force)");

    hostFailures.set("pane_current_command", new Error("lookup bad"));
    await expect(cmdTmuxSend("%4", "echo x")).rejects.toThrow("pane lookup failed for '%4' (from pane-id): lookup bad");

    hostResponses.set("pane_current_command", "zsh\n");
    hostFailures = new Map([["send-keys", new Error("send bad")]]);
    await expect(cmdTmuxSend("%5", "echo x")).rejects.toThrow("send-keys failed for '%5': send bad");
  });

  test("split/layout/kill cover invalid and host failure branches", async () => {
    await expect(cmdTmuxSplit("%1", { pct: 0 })).rejects.toThrow("--pct must be 1-99 (got 0)");
    hostFailures.set("split-window", new Error("split bad"));
    await expect(cmdTmuxSplit("%1")).rejects.toThrow("split-window failed for '%1' (from pane-id): split bad");

    await expect(cmdTmuxLayout("%1", "spiral")).rejects.toThrow("invalid layout 'spiral'");
    hostFailures = new Map([["select-layout", new Error("layout bad")]]);
    await expect(cmdTmuxLayout("%1", "tiled")).rejects.toThrow("select-layout failed for '%1' (from pane-id): layout bad");

    hostFailures = new Map([["kill-pane", new Error("kill bad")]]);
    await expect(cmdTmuxKill("%1")).rejects.toThrow("kill failed for '%1' (from pane-id): kill bad");
  });

  test("kill resolves fallback pane aliases before issuing kill-pane", async () => {
    hostResponses.set(
      "list-panes -a -F",
      "%71|||demo:2.0|||worker-title|||tile-role|||/repos/mawjs-oracle.wt-7-codex\n",
    );

    const printed = await capture(() => cmdTmuxKill("mawjs-codex"));

    expect(hostCalls).toContain("tmux list-panes -a -F '#{pane_id}|||#{session_name}:#{window_index}.#{pane_index}|||#{pane_title}|||#{@maw_tile_role}|||#{pane_current_path}'");
    expect(hostCalls.at(-1)).toBe("tmux kill-pane -t '%71'");
    expect(printed.logs).toContain("killed pane mawjs-codex → %71");
    expect(printed.logs).toContain("worktree-alias (mawjs-codex)");
  });

  test("kill reports ambiguous pane aliases with concrete targets", async () => {
    hostResponses.set(
      "list-panes -a -F",
      [
        "%71|||demo:2.0|||codex||||||/repos/a",
        "%72|||demo:3.0|||codex||||||/repos/b",
      ].join("\n"),
    );

    await expect(cmdTmuxKill("codex")).rejects.toThrow("'codex' is ambiguous — matches 2 panes:");
    expect(hostCalls.at(-1)).toContain("list-panes -a -F");
    expect(hostCalls).not.toContain("tmux kill-pane -t 'codex'");
  });

  test("attach recovery auto-wakes one candidate and exits for invalid tty selection", async () => {
    impl._tty.isStdoutTTY = () => true;
    ghqRepos = ["/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle"];
    spawnExitCode = 23;
    let exits = installProcessExitThrow();

    const autoWake = await capture(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:23");
    });
    expect(autoWake.logs).toContain("auto-selecting: Soul-Brews-Studio/pulse-oracle");
    expect(spawnCalls).toEqual([{ args: ["maw", "wake", "Soul-Brews-Studio/pulse-oracle", "-a"], opts: { stdio: ["inherit", "inherit", "inherit"] } }]);
    expect(exits).toEqual([23]);

    (process as any).exit = original.exit;
    spawnCalls = [];
    ghqRepos = ["/repos/one/pulse-oracle", "/repos/two/pulse-oracle"];
    ttyReadText = "9\n";
    exits = installProcessExitThrow();
    const invalidChoice = await capture(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:1");
    });
    expect(invalidChoice.logs).toContain("Wake which oracle?");
    expect(invalidChoice.writes).toContain("Select [1-2]");
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([1]);
  });

  test("small pure helpers cover malformed timestamps, repo slug fallbacks, and live prefix resolution", () => {
    expect(parseSessionCreatedList("ok\t123\nzero\t0\nbad\tnope\nmissing\n")).toEqual(new Map([["ok", 123]]));
    expect(formatSessionCreated(Number.NaN)).toBe("—");
    expect(formatSessionCreated(0)).toBe("—");
    expect(similarOracleCandidatesFromRepos("pulse", ["pulse-oracle", "/a/b/pulse-oracle", "/a/b/pulse-oracle", "/a/b/other"])).toEqual([
      "pulse-oracle",
      "b/pulse-oracle",
    ]);

    tmuxSessionsStdout = "101-mawjs\n102-other\n";
    expect(resolveTmuxTarget("mawjs")).toEqual({ resolved: "101-mawjs", source: "live-session (101-mawjs)" });

    ghqListThrows = true;
    expect(similarOracleCandidatesFromRepos("x", [])).toEqual([]);
  });
});
