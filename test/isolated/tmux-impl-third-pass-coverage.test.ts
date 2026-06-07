import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home";
const teamsRoot = `${mockHome}/.claude/teams`;

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let existingPaths = new Set<string>();
let dirEntries = new Map<string, string[]>();
let fileContents = new Map<string, string>();
let spawnCalls: unknown[] = [];
let hostCalls: string[] = [];
let hostResponses = new Map<string, string>();
let panes: Pane[] = [];
let fleetFiles: string[] = [];
let ghqShouldThrow = false;
let scanShouldThrow = false;

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string) => dirEntries.get(path) ?? [],
  readFileSync: (path: string) => {
    const hit = fileContents.get(path);
    if (hit === undefined) throw new Error(`missing mock file: ${path}`);
    return hit;
  },
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostCalls.push(cmd);
    for (const [needle, value] of hostResponses) {
      if (cmd.includes(needle)) return value;
    }
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "visible-session\n";
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
  loadFleetEntries: () => fleetFiles.map(file => ({ file })),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => {
    if (ghqShouldThrow) throw new Error("ghq unavailable");
    return ["/opt/Code/github.com/Soul-Brews-Studio/sleepy-oracle"];
  },
  ghqListSync: () => [],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => {
    if (scanShouldThrow) throw new Error("scan unavailable");
    return [];
  },
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const { cmdTmuxLs, cmdTmuxSplit, resolveTmuxTarget } = impl;

const original = {
  log: console.log,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
};

async function capture(fn: () => void | Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = original.log;
  }
  return logs.join("\n");
}

function spawnResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    success: exitCode === 0,
  };
}

beforeEach(() => {
  existingPaths = new Set();
  dirEntries = new Map();
  fileContents = new Map();
  spawnCalls = [];
  hostCalls = [];
  hostResponses = new Map();
  panes = [];
  fleetFiles = [];
  ghqShouldThrow = false;
  scanShouldThrow = false;
  delete process.env.TMUX;
  (Bun as any).spawnSync = (args: unknown[]) => {
    spawnCalls.push(args);
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult("alpha-live\n117-mawjs\n");
    }
    return spawnResult();
  };
});

afterEach(() => {
  console.log = original.log;
  (Bun as any).spawnSync = original.spawnSync;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl third-pass branch coverage", () => {
  test("resolveTmuxTarget walks team configs, skips invalid members/configs, and returns the team pane", () => {
    existingPaths.add(teamsRoot);
    dirEntries.set(teamsRoot, ["broken", "team-a", "team-b"]);

    const brokenCfg = `${teamsRoot}/broken/config.json`;
    const teamACfg = `${teamsRoot}/team-a/config.json`;
    const teamBCfg = `${teamsRoot}/team-b/config.json`;
    existingPaths.add(brokenCfg);
    existingPaths.add(teamACfg);
    existingPaths.add(teamBCfg);

    fileContents.set(brokenCfg, "{not json");
    fileContents.set(teamACfg, JSON.stringify({
      members: [
        { name: "scout", tmuxPaneId: "in-process" },
        { name: "scout", tmuxPaneId: "" },
      ],
    }));
    fileContents.set(teamBCfg, JSON.stringify({ members: [{ name: "scout", tmuxPaneId: "%77" }] }));

    expect(resolveTmuxTarget("scout")).toEqual({
      resolved: "%77",
      source: "team-agent (team-b)",
    });
  });

  test("resolveTmuxTarget falls through team/fleet misses to live-session fuzzy matching, then session-name fallback", () => {
    existingPaths.add(teamsRoot);
    dirEntries.set(teamsRoot, ["no-config"]);
    fleetFiles = ["101-other.json"];

    expect(resolveTmuxTarget("mawjs")).toEqual({
      resolved: "117-mawjs",
      source: "live-session (117-mawjs)",
    });

    (Bun as any).spawnSync = () => spawnResult("", 1);
    expect(resolveTmuxTarget("totally-missing")).toEqual({
      resolved: "totally-missing",
      source: "session-name",
    });
  });

  test("cmdTmuxLs noncompact view renders team, view, orphan, unknown age, and tolerates optional data failures", async () => {
    existingPaths.add(teamsRoot);
    dirEntries.set(teamsRoot, ["ops", "bad"]);
    const opsCfg = `${teamsRoot}/ops/config.json`;
    const badCfg = `${teamsRoot}/bad/config.json`;
    existingPaths.add(opsCfg);
    existingPaths.add(badCfg);
    fileContents.set(opsCfg, JSON.stringify({ members: [{ name: "pilot", tmuxPaneId: "%1" }] }));
    fileContents.set(badCfg, "not json");
    fleetFiles = ["101-fleet.json"];
    scanShouldThrow = true;
    ghqShouldThrow = true;
    panes = [
      { id: "%1", target: "scratch:0.0", command: "node", title: "team pane" },
      { id: "%2", target: "101-fleet:0.0", command: "zsh", title: "fleet pane", lastActivity: Math.floor(Date.now() / 1000) - 10 },
      { id: "%3", target: "maw-view:0.0", command: "zsh", title: "view pane", lastActivity: Math.floor(Date.now() / 1000) - 60 },
      { id: "%4", target: "loose:0.0", command: "claude", title: "orphan pane", lastActivity: Math.floor(Date.now() / 1000) - 3600 },
    ];

    const verbose = await capture(() => cmdTmuxLs({ all: true, verbose: true }));
    expect(verbose).toContain("scratch:0.0");
    expect(verbose).toContain("team: pilot @ ops");
    expect(verbose).toContain("fleet: fleet");
    expect(verbose).toContain("view: maw-view");
    expect(verbose).toContain("orphan");
    expect(verbose).toContain("1m");
    expect(verbose).toContain("1h0m");

    const compactRoster = await capture(() => cmdTmuxLs({ all: true, compact: true, roster: true }));
    expect(compactRoster).toContain("scratch");
    expect(compactRoster).toContain("maw ls -v");
    expect(compactRoster).not.toContain("sleepy-oracle");
  });

  test("cmdTmuxLs filters to current session when inside tmux and split defaults to horizontal 50% without command", async () => {
    process.env.TMUX = "/tmp/tmux,1,0";
    panes = [
      { id: "%1", target: "visible-session:0.0", command: "zsh", title: "shown", lastActivity: Math.floor(Date.now() / 1000) },
      { id: "%2", target: "hidden-session:0.0", command: "zsh", title: "hidden", lastActivity: Math.floor(Date.now() / 1000) },
    ];

    const out = await capture(() => cmdTmuxLs({ verbose: true }));
    expect(out).toContain("visible-session:0.0");
    expect(out).not.toContain("hidden-session:0.0");

    hostCalls = [];
    await capture(() => cmdTmuxSplit("%1"));
    expect(hostCalls.at(-1)).toBe("tmux split-window -h -l 50% -t '%1'");
  });
});
