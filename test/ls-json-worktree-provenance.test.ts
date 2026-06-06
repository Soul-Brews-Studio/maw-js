import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

type Pane = {
  id: string;
  target: string;
  command?: string;
  title?: string;
  cwd?: string;
  lastActivity?: number;
};

let panes: Pane[] = [];
let config: any = {};
let gitRoots = new Map<string, string>();
let gitBranches = new Map<string, string>();
let gitHeads = new Map<string, string>();
let gitRemotes = new Map<string, string>();
let commands: string[] = [];

mock.module("os", () => ({
  homedir: () => "/mock-home",
  hostname: () => "host-fallback",
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  tmux: { listPanes: async () => panes, capture: async () => "" },
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("rev-parse --show-toplevel")) {
      for (const [cwd, root] of gitRoots) if (cmd.includes(`'${cwd}'`)) return root;
      throw new Error("not a git repo");
    }
    if (cmd.includes("branch --show-current")) {
      for (const [root, branch] of gitBranches) if (cmd.includes(`'${root}'`)) return branch;
      return "";
    }
    if (cmd.includes("rev-parse --short=8 HEAD")) {
      for (const [root, head] of gitHeads) if (cmd.includes(`'${root}'`)) return head;
      return "";
    }
    if (cmd.includes("config --get remote.origin.url")) {
      for (const [root, remote] of gitRemotes) if (cmd.includes(`'${root}'`)) return remote;
      return "";
    }
    return "";
  },
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [{ file: "101-mawjs.json" }],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({ scanWorktrees: async () => [] }));
mock.module(join(srcRoot, "src/core/ghq"), () => ({ ghqList: async () => [], ghqListSync: () => [] }));

const { cmdTmuxLs, describePaneWorktree, paneProvenance } = await import("../src/commands/plugins/tmux/impl");

const originalLog = console.log;

async function captureJson(fn: () => Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try { await fn(); } finally { console.log = originalLog; }
  return JSON.parse(logs.join("\n"));
}

const countCommands = (needle: string) => commands.filter(cmd => cmd.includes(needle)).length;

beforeEach(() => {
  panes = [];
  config = { node: "m5", oracle: "mawjs", sessionIds: { "mawjs-oracle": "26a2aa25" } };
  gitRoots = new Map();
  gitBranches = new Map();
  gitHeads = new Map();
  gitRemotes = new Map();
  commands = [];
  delete process.env.MAW_NODE;
  delete process.env.MAW_SESSION_ID;
});

describe("maw ls --json worktree and provenance metadata (#1990/#1991)", () => {
  test("adds worktree and provenance while preserving cwd and sharing git metadata", async () => {
    panes = [{ id: "%1", target: "101-mawjs:mawjs-oracle.1", command: "claude", cwd: "/repo/agents/1" }];
    gitRoots.set("/repo/agents/1", "/repo/agents/1");
    gitBranches.set("/repo/agents/1", "agents/1-codex");
    gitHeads.set("/repo/agents/1", "a596969b");
    gitRemotes.set("/repo/agents/1", "git@github.com:Soul-Brews-Studio/mawjs-oracle.git");

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0]).toMatchObject({ cwd: "/repo/agents/1", activity: "unknown" });
    expect(rows[0].worktree).toEqual({ path: "/repo/agents/1", branch: "agents/1-codex", head: "a596969b" });
    expect(rows[0].provenance).toEqual({
      oracle: "mawjs-oracle",
      machine: "m5",
      session: "26a2aa25",
      federation: "m5:mawjs-oracle",
      org: "Soul-Brews-Studio",
      repo: "mawjs-oracle",
      commit: "a596969b",
      engine: "claude",
    });
    expect(countCommands("rev-parse --show-toplevel")).toBe(1);
    expect(countCommands("rev-parse --short=8 HEAD")).toBe(1);
  });

  test("keeps null-safe metadata for panes outside git", async () => {
    expect(await describePaneWorktree(undefined)).toBeNull();
    config = {};
    process.env.MAW_SESSION_ID = "env-session";
    panes = [{ id: "%2", target: "scratch:0.0", command: "zsh", cwd: "/tmp" }];

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0].cwd).toBe("/tmp");
    expect(rows[0].worktree).toBeNull();
    expect(rows[0].provenance).toMatchObject({
      oracle: "scratch-oracle",
      machine: "host-fallback",
      session: "env-session",
      org: null,
      repo: null,
      commit: null,
      engine: "zsh",
    });
  });

  test("exports provenance helper with hostname fallback", async () => {
    config = {};
    process.env.MAW_SESSION_ID = "env-session";

    await expect(paneProvenance({ target: "scratch:0.0", session: "scratch", command: "zsh" })).resolves.toMatchObject({
      oracle: "scratch-oracle",
      machine: "host-fallback",
      session: "env-session",
      commit: null,
      engine: "zsh",
    });
  });
});
