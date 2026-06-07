/**
 * Targeted isolated coverage for src/commands/plugins/swarm/index.ts.
 *
 * The swarm command creates tmux panes and writes ~/.claude team metadata, so the
 * side-effecting seams are mocked while the index handler's routing, branching,
 * output, and config-writing behavior are exercised directly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

type CallLog = {
  hostExec: string[];
  withPaneLock: number;
  stylePaneBorder: Array<[string, string, string]>;
  enableBorderStatus: string[];
  applyTeamLayout: Array<[string, string]>;
  applyTiledLayout: string[];
  getWindowTarget: number;
  saveLayoutSnapshot: Array<[string, string]>;
};

const calls: CallLog = {
  hostExec: [],
  withPaneLock: 0,
  stylePaneBorder: [],
  enableBorderStatus: [],
  applyTeamLayout: [],
  applyTiledLayout: [],
  getWindowTarget: 0,
  saveLayoutSnapshot: [],
};

const colors = ["blue", "green", "yellow", "cyan", "magenta", "red", "white", "orange"];
const ansiByColor: Record<string, string> = {
  blue: "34",
  green: "32",
  yellow: "33",
  cyan: "36",
  magenta: "35",
  red: "31",
  white: "37",
  orange: "38;5;208",
};

let homeDir = mkdtempSync(join(tmpdir(), "maw-swarm-index-"));
let configCommands: Record<string, string> = {};
let splitCounter = 0;
let sendKeysCounter = 0;
let failOnSendKeysNumber: number | undefined;

const originalEnv = { ...process.env };
const originalLog = console.log;
const originalSetTimeout = globalThis.setTimeout;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    calls.hostExec.push(cmd);
    if (cmd.includes("tmux split-window")) return `%pane${++splitCounter}\n`;
    if (cmd.includes("tmux send-keys")) {
      sendKeysCounter += 1;
      if (sendKeysCounter === failOnSendKeysNumber) throw new Error("send failed");
    }
    return "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    calls.withPaneLock += 1;
    await fn();
  },
}));

mock.module(at("../../src/config"), () => ({
  loadConfig: () => ({ commands: configCommands }),
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (index: number) => colors[index % colors.length],
  colorAnsi: (color: string) => ansiByColor[color] ?? "37",
  stylePaneBorder: async (paneId: string, title: string, color: string) => {
    calls.stylePaneBorder.push([paneId, title, color]);
  },
  enableBorderStatus: async (windowTarget: string) => {
    calls.enableBorderStatus.push(windowTarget);
    return true;
  },
  applyTeamLayout: async (windowTarget: string, anchor: string) => {
    calls.applyTeamLayout.push([windowTarget, anchor]);
  },
  applyTiledLayout: async (windowTarget: string) => {
    calls.applyTiledLayout.push(windowTarget);
  },
  getWindowTarget: async () => {
    calls.getWindowTarget += 1;
    return "window-1";
  },
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  saveLayoutSnapshot: (teamName: string, anchor: string) => {
    calls.saveLayoutSnapshot.push([teamName, anchor]);
  },
}));

const { command, default: swarmHandler } = await import("../../src/commands/plugins/swarm/index.ts?swarm-index-coverage");

function resetCalls() {
  calls.hostExec = [];
  calls.withPaneLock = 0;
  calls.stylePaneBorder = [];
  calls.enableBorderStatus = [];
  calls.applyTeamLayout = [];
  calls.applyTiledLayout = [];
  calls.getWindowTarget = 0;
  calls.saveLayoutSnapshot = [];
}

function teamDir(): string {
  return join(homeDir, ".claude", "teams", "swarm");
}

function configPath(): string {
  return join(teamDir(), "config.json");
}

function readConfig(): any {
  return JSON.parse(readFileSync(configPath(), "utf-8"));
}

function run(args: string[], options: { source?: "cli" | "api"; writer?: (...args: unknown[]) => void } = {}) {
  return swarmHandler({
    source: options.source ?? "cli",
    args,
    writer: options.writer,
  } as any);
}

beforeEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-swarm-index-"));
  resetCalls();
  configCommands = {};
  splitCounter = 0;
  sendKeysCounter = 0;
  failOnSendKeysNumber = undefined;
  process.env.TMUX = "/tmp/tmux-coverage";
  process.env.TMUX_PANE = "%leader";
  console.log = originalLog;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) => {
    handler(...args);
    return 0 as any;
  }) as typeof setTimeout;
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
  console.log = originalLog;
  globalThis.setTimeout = originalSetTimeout;
});

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("swarm command metadata", () => {
  test("exports command name and description", () => {
    expect(command).toEqual({
      name: "swarm",
      description: "Spawn multi-AI agent panes — claude, codex, opencode side by side.",
    });
  });
});

describe("swarm index handler isolated coverage", () => {
  test("requires tmux, writes the warning through ctx.writer, and restores console.log", async () => {
    delete process.env.TMUX;
    const written: string[] = [];
    const result = await run([], { writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")) });

    expect(result).toEqual({ ok: false, error: "not in tmux" });
    expect(written.join("\n")).toContain("swarm requires tmux");
    expect(calls.hostExec).toEqual([]);
    expect(console.log).toBe(originalLog);
  });

  test("prints help from the -h alias before touching tmux or filesystem side effects", async () => {
    const result = await run(["-h"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw swarm [agents...] [--tiled] [--count N]");
    expect(result.output).toContain("Supported: claude, codex, opencode, aider, or any command");
    expect(calls.hostExec).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });

  test("rejects more than ten requested agents before importing side-effecting helpers", async () => {
    const result = await run(Array.from({ length: 11 }, (_, i) => `agent-${i}`));

    expect(result).toEqual({ ok: false, error: "max 10" });
    expect(calls.hostExec).toEqual([]);
    expect(calls.saveLayoutSnapshot).toEqual([]);
  });

  test("spawns default claude agents from a cli invocation using anchored main-vertical layout", async () => {
    const result = await run([]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("swarm: 3 agents (main-vertical)");
    expect(calls.withPaneLock).toBe(3);
    expect(calls.hostExec.filter((cmd) => cmd.includes("tmux split-window"))).toEqual([
      "tmux split-window -t '%leader' -h -P -F '#{pane_id}' 'exec zsh -li'",
      "tmux split-window -t '%leader' -h -P -F '#{pane_id}' 'exec zsh -li'",
      "tmux split-window -t '%leader' -h -P -F '#{pane_id}' 'exec zsh -li'",
    ]);
    expect(calls.applyTeamLayout).toEqual([["window-1", "%leader"]]);
    expect(calls.applyTiledLayout).toEqual([]);
    expect(calls.enableBorderStatus).toEqual(["window-1"]);
    expect(calls.stylePaneBorder).toEqual([
      ["%pane1", "claude-1 (Claude Code)", "blue"],
      ["%pane2", "claude-2 (Claude Code)", "green"],
      ["%pane3", "claude-3 (Claude Code)", "yellow"],
    ]);
    expect(calls.saveLayoutSnapshot).toEqual([["swarm", "%leader"]]);

    const config = readConfig();
    expect(config.name).toBe("swarm");
    expect(config.description).toBe("Multi-AI swarm");
    expect(config.members).toEqual([
      { name: "claude-1", agentId: "claude-1@swarm", tmuxPaneId: "%pane1", color: "blue", model: "claude" },
      { name: "claude-2", agentId: "claude-2@swarm", tmuxPaneId: "%pane2", color: "green", model: "claude" },
      { name: "claude-3", agentId: "claude-3@swarm", tmuxPaneId: "%pane3", color: "yellow", model: "claude" },
    ]);
  });

  test("ignores non-cli args and skips layout selection when there is no anchor and --tiled is absent", async () => {
    delete process.env.TMUX_PANE;

    const result = await run(["--count", "9", "codex"], { source: "api" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("swarm: 3 agents (main-vertical)");
    expect(calls.hostExec.filter((cmd) => cmd.includes("tmux split-window"))).toEqual([
      "tmux split-window -h -P -F '#{pane_id}' 'exec zsh -li'",
      "tmux split-window -h -P -F '#{pane_id}' 'exec zsh -li'",
      "tmux split-window -h -P -F '#{pane_id}' 'exec zsh -li'",
    ]);
    expect(calls.applyTeamLayout).toEqual([]);
    expect(calls.applyTiledLayout).toEqual([]);
    expect(calls.saveLayoutSnapshot).toEqual([["swarm", ""]]);
    expect(readConfig().members.map((member: any) => member.name)).toEqual(["claude-1", "claude-2", "claude-3"]);
  });

  test("honors --count with tiled layout", async () => {
    delete process.env.TMUX_PANE;

    const result = await run(["--count", "2", "--tiled"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("swarm: 2 agents (tiled)");
    expect(calls.applyTiledLayout).toEqual(["window-1"]);
    expect(calls.applyTeamLayout).toEqual([]);
    expect(calls.stylePaneBorder.map((call) => call[1])).toEqual([
      "claude-1 (Claude Code)",
      "claude-2 (Claude Code)",
    ]);
    expect(readConfig().members).toHaveLength(2);
  });

  test("uses positional agent names, config command overrides, custom labels, escaping, and member replacement", async () => {
    mkdirSync(teamDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({
      name: "swarm",
      description: "existing swarm",
      members: [
        { name: "codex-1", agentId: "old@swarm", tmuxPaneId: "%old", color: "red", model: "old-codex" },
        { name: "keep", agentId: "keep@swarm", tmuxPaneId: "%keep", color: "white", model: "manual" },
      ],
      createdAt: 111,
    }));
    configCommands = {
      codex: "codex --profile coverage",
      custom: "say 'hi'",
    };

    const result = await run(["codex", "opencode", "custom", "aider"]);

    expect(result.ok).toBe(true);
    expect(calls.stylePaneBorder.map((call) => call[1])).toEqual([
      "codex-1 (Codex CLI)",
      "opencode-2 (OpenCode)",
      "custom-3 (custom)",
      "aider-4 (Aider)",
    ]);
    const sendCommands = calls.hostExec.filter((cmd) => cmd.includes("tmux send-keys"));
    expect(sendCommands[0]).toContain("codex --profile coverage");
    expect(sendCommands[2]).toContain("say '\\''hi'\\''");
    expect(sendCommands[3]).toContain("aider");

    const config = readConfig();
    expect(config.description).toBe("existing swarm");
    expect(config.createdAt).toBe(111);
    expect(config.members).toEqual([
      { name: "codex-1", agentId: "codex-1@swarm", tmuxPaneId: "%pane1", color: "blue", model: "codex --profile coverage" },
      { name: "keep", agentId: "keep@swarm", tmuxPaneId: "%keep", color: "white", model: "manual" },
      { name: "opencode-2", agentId: "opencode-2@swarm", tmuxPaneId: "%pane2", color: "green", model: "opencode" },
      { name: "custom-3", agentId: "custom-3@swarm", tmuxPaneId: "%pane3", color: "yellow", model: "say 'hi'" },
      { name: "aider-4", agentId: "aider-4@swarm", tmuxPaneId: "%pane4", color: "cyan", model: "aider" },
    ]);
  });

  test("returns caught host execution errors with logs accumulated before the failure", async () => {
    failOnSendKeysNumber = 2;

    const result = await run(["claude", "codex"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("send failed");
    expect(result.output).toContain("claude-1 (Claude Code) → %pane1");
    expect(result.output).not.toContain("codex-2 (Codex CLI) → %pane2");
    expect(console.log).toBe(originalLog);
  });
});
