/**
 * Tests for isPaneIdle, ensureSessionRunning, createWorktree
 * from src/commands/shared/wake-session.ts.
 * Mocks tmux, hostExec, config to test session wake logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "wake-session-"));

const hostExecCalls: string[] = [];
let hostExecResult = "";
const sendTextCalls: { target: string; cmd: string }[] = [];
let listWindowsResult: { index: number; name: string; active: boolean }[] = [];
let paneCommandsResult: Record<string, string> = {};

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rSdk = await import("../../src/sdk");

mock.module("../../src/sdk", () => ({
  ..._rSdk,
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("pgrep") && hostExecResult === "has-children") return "12345";
    if (cmd.includes("pane_pid")) return "99999";
    return hostExecResult;
  },
  tmux: {
    listWindows: async () => listWindowsResult,
    getPaneCommands: async (targets: string[]) => paneCommandsResult,
    sendText: async (target: string, cmd: string) => {
      sendTextCalls.push({ target, cmd });
    },
    switchClient: async () => {},
    ls: async () => [],
    run: async () => "",
    kill: async () => {},
    killWindow: async () => {},
  },
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({
    ghqRoot: tmp,
    node: "test",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (name: string) => `maw run ${name}`,
  buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && maw run ${name}`,
  cfgTimeout: () => 50, // short for tests
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

const { isPaneIdle, ensureSessionRunning, createWorktree } = await import(
  "../../src/commands/shared/wake-session"
);

beforeEach(() => {
  hostExecCalls.length = 0;
  sendTextCalls.length = 0;
  hostExecResult = "";
  listWindowsResult = [];
  paneCommandsResult = {};
});

describe("isPaneIdle", () => {
  it("returns true when no children (empty pgrep)", async () => {
    hostExecResult = "";
    const result = await isPaneIdle("session:window");
    expect(result).toBe(true);
  });

  it("returns false when pane has children", async () => {
    hostExecResult = "has-children";
    const result = await isPaneIdle("session:window");
    expect(result).toBe(false);
  });

  it("queries tmux for pane pid", async () => {
    await isPaneIdle("my-session:my-window");
    expect(hostExecCalls.some(c => c.includes("pane_pid"))).toBe(true);
  });
});

describe("ensureSessionRunning", () => {
  it("returns 0 for no windows", async () => {
    listWindowsResult = [];
    const result = await ensureSessionRunning("test-session");
    expect(result).toBe(0);
  });

  it("retries idle shell windows", async () => {
    listWindowsResult = [{ index: 0, name: "neo-oracle", active: true }];
    paneCommandsResult = { "test-session:neo-oracle": "zsh" };
    hostExecResult = ""; // no children = idle

    const result = await ensureSessionRunning("test-session");
    expect(result).toBe(1);
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0].target).toBe("test-session:neo-oracle");
  });

  it("skips excluded window names", async () => {
    listWindowsResult = [{ index: 0, name: "skip-me", active: true }];
    paneCommandsResult = { "test-session:skip-me": "zsh" };

    const result = await ensureSessionRunning("test-session", new Set(["skip-me"]));
    expect(result).toBe(0);
    expect(sendTextCalls).toHaveLength(0);
  });

  it("skips windows running real commands (not shell)", async () => {
    listWindowsResult = [{ index: 0, name: "worker", active: true }];
    paneCommandsResult = { "test-session:worker": "bun run src/server.ts" };

    const result = await ensureSessionRunning("test-session");
    expect(result).toBe(0);
    expect(sendTextCalls).toHaveLength(0);
  });

  it("uses buildCommandInDir when cwdMap provided", async () => {
    listWindowsResult = [{ index: 0, name: "neo-oracle", active: true }];
    paneCommandsResult = { "test-session:neo-oracle": "bash" };
    hostExecResult = "";

    await ensureSessionRunning("test-session", undefined, { "neo-oracle": "/some/path" });
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0].cmd).toContain("/some/path");
  });

  it("treats empty pane command as idle shell", async () => {
    listWindowsResult = [{ index: 0, name: "oracle", active: true }];
    paneCommandsResult = { "test-session:oracle": "" };
    hostExecResult = "";

    const result = await ensureSessionRunning("test-session");
    expect(result).toBe(1);
  });
});

describe("createWorktree", () => {
  it("creates worktree with correct path and branch", async () => {
    const result = await createWorktree(
      "/repo/path", "/parent", "my-repo", "neo", "task1", [],
    );
    expect(result.wtPath).toBe("/parent/my-repo.wt-1-task1");
    expect(result.windowName).toBe("neo-task1");
    expect(hostExecCalls.some(c => c.includes("worktree add"))).toBe(true);
  });

  it("increments worktree number from existing", async () => {
    const result = await createWorktree(
      "/repo/path", "/parent", "my-repo", "neo", "task2",
      [{ name: "3", path: "/existing" }],
    );
    expect(result.wtPath).toContain("wt-4-task2");
  });

  it("creates branch with agents/ prefix", async () => {
    await createWorktree("/repo", "/parent", "repo", "neo", "fix", []);
    const branchCmd = hostExecCalls.find(c => c.includes("worktree add"));
    expect(branchCmd).toContain("agents/1-fix");
  });

  it("tries to delete existing branch before creating", async () => {
    await createWorktree("/repo", "/parent", "repo", "neo", "test", []);
    expect(hostExecCalls.some(c => c.includes("branch -D"))).toBe(true);
  });
});
