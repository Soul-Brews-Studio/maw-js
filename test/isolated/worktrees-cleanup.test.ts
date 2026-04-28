/**
 * Tests for cleanupWorktree from src/core/fleet/worktrees-cleanup.ts.
 * Mocks tmux, ssh, config, and matcher to test cleanup logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "wt-cleanup-"));
const fleetDir = join(tmp, "fleet");
const ghqRoot = join(tmp, "ghq");
mkdirSync(fleetDir, { recursive: true });
mkdirSync(ghqRoot, { recursive: true });

const killedWindows: string[] = [];
let sessions: { name: string; windows: { name: string; index: number; active: boolean }[] }[] = [];
const execLog: string[] = [];
let resolveResult: any = { kind: "none" };

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: fleetDir,
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    ghqRoot,
    node: "test",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    killWindow: async (target: string) => { killedWindows.push(target); },
    ls: async () => [],
    sendText: async () => {},
    kill: async () => {},
    newWindow: async () => {},
    newSession: async () => {},
    hasSession: async () => false,
    splitWindow: async () => {},
    listAll: async () => [],
  },
}));

mock.module("../../src/core/transport/ssh", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    execLog.push(cmd);
    if (cmd.includes("rev-parse")) return "feat/my-branch\n";
    return "";
  },
  sendKeys: async () => {},
  selectWindow: async () => {},
  capture: async () => "",
  getPaneCommand: async () => "",
  getPaneInfos: async () => ({}),
}));

mock.module("../../src/core/matcher/resolve-target", () => ({
  resolveWorktreeTarget: () => resolveResult,
}));

const { cleanupWorktree } = await import("../../src/core/fleet/worktrees-cleanup");

beforeEach(() => {
  killedWindows.length = 0;
  execLog.length = 0;
  sessions = [];
  resolveResult = { kind: "none" };
  // Clean fleet dir
  try {
    const { readdirSync, rmSync } = require("fs");
    for (const f of readdirSync(fleetDir)) {
      rmSync(join(fleetDir, f), { force: true });
    }
  } catch {}
});

describe("cleanupWorktree", () => {
  it("rejects non-worktree paths", async () => {
    const log = await cleanupWorktree("/some/path/regular-dir");
    expect(log.some(l => l.includes("not a worktree"))).toBe(true);
  });

  it("handles valid worktree path with no running window", async () => {
    const wtPath = join(ghqRoot, "org", "my-repo.wt-123-feature");
    const log = await cleanupWorktree(wtPath);
    expect(log.some(l => l.includes("removed worktree") || l.includes("worktree remove failed"))).toBe(true);
  });

  it("kills tmux window on exact match", async () => {
    resolveResult = {
      kind: "exact",
      match: { name: "neo-oracle", session: "proj" },
    };
    const wtPath = join(ghqRoot, "org", "my-repo.wt-1-neo-oracle");
    await cleanupWorktree(wtPath);
    expect(killedWindows).toContain("proj:neo-oracle");
  });

  it("kills tmux window on fuzzy match", async () => {
    resolveResult = {
      kind: "fuzzy",
      match: { name: "pulse-oracle", session: "proj" },
    };
    const wtPath = join(ghqRoot, "org", "my-repo.wt-2-pulse");
    await cleanupWorktree(wtPath);
    expect(killedWindows).toContain("proj:pulse-oracle");
  });

  it("skips kill on ambiguous match", async () => {
    resolveResult = {
      kind: "ambiguous",
      candidates: [
        { name: "neo-oracle", session: "proj1" },
        { name: "neo-oracle", session: "proj2" },
      ],
    };
    const wtPath = join(ghqRoot, "org", "my-repo.wt-3-neo");
    const log = await cleanupWorktree(wtPath);
    expect(killedWindows).toHaveLength(0);
    expect(log.some(l => l.includes("ambiguous"))).toBe(true);
  });

  it("runs git worktree remove and prune", async () => {
    const wtPath = join(ghqRoot, "org", "my-repo.wt-4-task");
    await cleanupWorktree(wtPath);
    expect(execLog.some(c => c.includes("worktree remove"))).toBe(true);
    expect(execLog.some(c => c.includes("worktree prune"))).toBe(true);
  });

  it("attempts branch deletion", async () => {
    const wtPath = join(ghqRoot, "org", "my-repo.wt-5-task");
    await cleanupWorktree(wtPath);
    expect(execLog.some(c => c.includes("branch -d"))).toBe(true);
    expect(execLog.some(c => c.includes("feat/my-branch"))).toBe(true);
  });

  it("removes entry from fleet config", async () => {
    // Write a fleet config with a window matching the worktree
    const cfg = {
      name: "test-fleet",
      windows: [
        { repo: "org/my-repo.wt-6-cleanup", name: "test" },
        { repo: "org/other-repo", name: "keep" },
      ],
    };
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify(cfg));

    const wtPath = join(ghqRoot, "org", "my-repo.wt-6-cleanup");
    const log = await cleanupWorktree(wtPath);

    const updated = JSON.parse(readFileSync(join(fleetDir, "test.json"), "utf-8"));
    expect(updated.windows).toHaveLength(1);
    expect(updated.windows[0].name).toBe("keep");
    expect(log.some(l => l.includes("removed from test.json"))).toBe(true);
  });

  it("does not modify fleet config when no match", async () => {
    const cfg = { name: "test", windows: [{ repo: "other/repo", name: "keep" }] };
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify(cfg));

    const wtPath = join(ghqRoot, "org", "my-repo.wt-7-other");
    const log = await cleanupWorktree(wtPath);

    const updated = JSON.parse(readFileSync(join(fleetDir, "test.json"), "utf-8"));
    expect(updated.windows).toHaveLength(1);
    expect(log.every(l => !l.includes("removed from"))).toBe(true);
  });
});
