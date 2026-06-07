import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-second-pass";

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let hostCalls: string[] = [];
let hostResponses = new Map<string, string>();
let hostFailures = new Map<string, Error>();
let panes: Pane[] = [];
let fleetFiles: string[] = [];
let spawnCalls: unknown[] = [];
let spawnShouldThrow = false;

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => [],
  readFileSync: () => { throw new Error("unexpected readFileSync"); },
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
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "visible\n";
    if (cmd.includes("list-panes -a -F")) return "";
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return "";
    if (cmd.includes("capture-pane")) return "captured output\n";
    return "";
  },
  tmux: {
    listPanes: async () => panes,
    capture: async () => "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetFiles.map(file => ({ file })),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => [],
  ghqListSync: () => [],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const {
  _sendTracker,
  annotatePane,
  cmdTmuxKill,
  cmdTmuxLayout,
  cmdTmuxLs,
  cmdTmuxPeek,
  cmdTmuxSend,
  cmdTmuxSplit,
  formatSessionCreated,
  parseSessionCreatedList,
  resolveTmuxTarget,
} = impl;

const original = {
  log: console.log,
  warn: console.warn,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
  dateNow: Date.now,
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

beforeEach(() => {
  hostCalls = [];
  hostResponses = new Map();
  hostFailures = new Map();
  panes = [];
  fleetFiles = [];
  spawnCalls = [];
  spawnShouldThrow = false;
  _sendTracker.clear();
  Date.now = original.dateNow;
  delete process.env.TMUX;
  (Bun as any).spawnSync = (args: unknown[]) => {
    spawnCalls.push(args);
    if (spawnShouldThrow) throw new Error("spawn unavailable");
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult("live-alpha\n117-mawjs\n", 0);
    }
    return spawnResult();
  };
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  (Bun as any).spawnSync = original.spawnSync;
  Date.now = original.dateNow;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl plugin second-pass isolated coverage", () => {
  test("parses session creation rows defensively and formats invalid dates as em dashes", () => {
    const parsed = parseSessionCreatedList("alpha\t100\nmissing-created\nzero\t0\nbad\tnope\nbeta\t200\n");

    expect([...parsed.entries()]).toEqual([
      ["alpha", 100],
      ["beta", 200],
    ]);
    expect(formatSessionCreated(Number.NaN)).toBe("—");
    expect(formatSessionCreated(0)).toBe("—");
  });

  test("resolve handles direct targets, live-session fallback, and spawnSync failures deterministically", () => {
    expect(resolveTmuxTarget("%44")).toEqual({ resolved: "%44", source: "pane-id" });
    expect(resolveTmuxTarget("demo:2.3")).toEqual({ resolved: "demo:2.3", source: "session:w.p" });
    expect(resolveTmuxTarget("mawjs")).toEqual({ resolved: "117-mawjs", source: "live-session (117-mawjs)" });

    spawnShouldThrow = true;
    expect(resolveTmuxTarget("fallback-name")).toEqual({ resolved: "fallback-name", source: "session-name" });
  });

  test("ls json and compact render unknown status, fleet/view/orphan annotations, and roster failure tolerance", async () => {
    Date.now = () => 1_700_000_000_000;
    fleetFiles = ["101-fleet.json"];
    panes = [
      { id: "%1", target: "101-fleet:0.0", command: "zsh", title: "fleet pane" },
      { id: "%2", target: "maw-view:0.0", command: "zsh", title: "view pane", lastActivity: Math.floor(Date.now() / 1000) - 31 },
      { id: "%3", target: "scratch:0.0", command: "claude", title: "orphan pane", lastActivity: Math.floor(Date.now() / 1000) - 301 },
    ];

    const json = await capture(() => cmdTmuxLs({ all: true, json: true }));
    expect(JSON.parse(json.logs)).toMatchObject([
      { id: "%1", annotation: "fleet: fleet", status: "unknown", lastActivitySec: 0 },
      { id: "%2", annotation: "view: maw-view", status: "idle" },
      { id: "%3", annotation: "orphan", status: "stale" },
    ]);

    const compact = await capture(() => cmdTmuxLs({ all: true, compact: true, roster: true }));
    expect(compact.logs).toContain("101-fleet");
    expect(compact.logs).toContain("maw-view");
    expect(compact.logs).toContain("scratch");
    expect(compact.logs).toContain("maw ls -v");
  });

  test("annotatePane precedence favors team over fleet, then view, orphan, and empty", () => {
    const fleet = new Set(["101-fleet"]);
    const teams = new Map([["%1", "pilot @ ops"]]);

    expect(annotatePane({ id: "%1", target: "101-fleet:0.0", command: "claude" }, fleet, teams)).toBe("team: pilot @ ops");
    expect(annotatePane({ id: "%2", target: "101-fleet:0.1", command: "zsh" }, fleet, teams)).toBe("fleet: fleet");
    expect(annotatePane({ id: "%3", target: "custom-view:0.0", command: "zsh" }, fleet, teams)).toBe("view: custom-view");
    expect(annotatePane({ id: "%4", target: "loose:0.0", command: "claude-code" }, fleet, teams)).toBe("orphan");
    expect(annotatePane({ id: "%5", target: "loose:0.1", command: "zsh" }, fleet, teams)).toBe("");
  });

  test("peek honors explicit line counts and wraps non-pane targets through resolver source", async () => {
    await capture(() => cmdTmuxPeek("demo:2.3", { lines: 5 }));
    expect(hostCalls).toEqual(["tmux capture-pane -pt 'demo:2.3' -S -5 -J"]);

    hostCalls = [];
    hostFailures.set("capture-pane", new Error("capture refused"));
    await expect(cmdTmuxPeek("mawjs", { history: true })).rejects.toThrow(
      "tmux capture-pane failed for '117-mawjs' (from live-session (117-mawjs)): capture refused",
    );
    expect(hostCalls.at(-1)).toBe("tmux capture-pane -pt '117-mawjs' -S - -J");
  });

  test("send renders success flags, destructive bypass, and shell quoting with force", async () => {
    const { logs } = await capture(() => cmdTmuxSend("%9", "echo 'safe' && rm -rf /tmp/demo", {
      allowDestructive: true,
      force: true,
      literal: true,
    }));

    expect(hostCalls[0]).toBe("tmux display-message -p -t '%9' '#{pane_current_command}'");
    expect(hostCalls[1]).toStartWith("tmux send-keys -t '%9' ");
    expect(hostCalls[1]).toContain("echo");
    expect(hostCalls[1]).toContain("safe");
    expect(hostCalls[1]).toContain("rm -rf /tmp/demo");
    expect(hostCalls[1]).not.toContain(" Enter");
    expect(logs).toContain("(literal)");
    expect(logs).toContain("(destructive-allowed)");
    expect(logs).toContain("(force)");
  });

  test("split and layout reject invalid parser inputs before host side effects", async () => {
    await expect(cmdTmuxSplit("%1", { pct: 0 })).rejects.toThrow("--pct must be 1-99 (got 0)");
    await expect(cmdTmuxSplit("%1", { pct: 100 })).rejects.toThrow("--pct must be 1-99 (got 100)");
    await expect(cmdTmuxLayout("%1", "spiral")).rejects.toThrow("invalid layout 'spiral'");
    expect(hostCalls).toEqual([]);
  });

  test("kill session-name fallback uses the bare target and wraps host kill errors", async () => {
    hostFailures.set("kill-pane", new Error("no such pane"));

    await expect(cmdTmuxKill("plain-shell")).rejects.toThrow("kill failed for 'plain-shell' (from session-name): no such pane");
    expect(hostCalls).toEqual([
      "tmux list-panes -a -F '#{pane_id}|||#{session_name}:#{window_index}.#{pane_index}|||#{pane_title}|||#{@maw_tile_role}|||#{pane_current_path}'",
      "tmux kill-pane -t 'plain-shell'",
    ]);
  });
});
