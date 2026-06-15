import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");

// This file imports tile impl at module scope; reset mocks first so earlier
// isolated files cannot leak a partial src/sdk/index.ts shim into that import.
mock.restore();

let commands: string[] = [];
let tilePaneList = "%lead|||leader|||\n";
let plainPaneList = "%lead\n";
let swapPaneRows = "0|||%lead|||lead|||0\n1|||%p1|||tile-1|||4\n2|||%p2|||tile-2|||14\n";
let worktreeList = "";
let nextPane = 1;
let throwParentAddress = false;
let throwWindowAddress = false;
let throwTilePaneList = false;
let throwGitTop = false;
let throwBranchDelete = false;
let layoutCalls: string[] = [];
let borderCalls: Array<{ paneId: string; label: string; color: string }> = [];
const originalTileCmdSettle = process.env.MAW_TILE_CMD_SETTLE_MS;

const sdkMock = () => ({
  cmdWorkspaceCreate: async () => undefined,
  cmdWorkspaceJoin: async () => undefined,
  cmdWorkspaceShare: async () => undefined,
  cmdWorkspaceUnshare: async () => undefined,
  cmdWorkspaceLs: async () => undefined,
  cmdWorkspaceAgents: async () => undefined,
  cmdWorkspaceInvite: async () => undefined,
  cmdWorkspaceLeave: async () => undefined,
  cmdWorkspaceTeam: async () => undefined,
  cmdWorkspaceStop: async () => undefined,
  cmdWorkspaceSessions: async () => undefined,
  cmdWorkspaceWhere: async () => undefined,
  cmdWorkspaceStatus: async () => undefined,
  cmdWorkspaceSend: async () => undefined,
  cmdWorkspaceInspect: async () => undefined,
  cmdWorkspaceSnapshot: async () => undefined,
  cmdWorkspaceRestore: async () => undefined,
  cmdWorkspaceClean: async () => undefined,
  mawStatePath: (...parts: string[]) => ["/tmp", ".maw", "state", ...parts].join("/"),
  UserError: class UserError extends Error {},

  parseFlags: () => ({}),
  getGhqRoot: () => process.cwd(),
  loadFleetCore: () => [],
  listSessions: async () => [],
  findPeerForTarget: async () => null,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false }),
  capture: async () => "",
  sendKeys: async () => undefined,
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  loadConfig: () => ({}),
  runHook: async () => undefined,
  withPaneLock: async (fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "%1",
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  Tmux: class { async killSession() {} },
  tmuxCmd: () => "tmux",
  resolveSocket: () => undefined,
  tmux: { run: async () => "", listPaneIds: async () => new Set<string>(), listSessions: async () => [] },
  resolveOraclePane: async (target: string) => target,
  cmdSleep: async () => undefined,
  cmdWakeAll: async () => undefined,
  C: { green: "", red: "", yellow: "", gray: "", reset: "" },
  invalidateManifest: () => undefined,
  isMawXdgEnabled: () => false,
  loadManifestCached: () => null,
  legacyMawPath: (...parts: string[]) => ["/tmp", ".maw", ...parts].join("/"),
  mawCacheDir: () => "/tmp/.maw/cache",
  mawConfigDir: () => "/tmp/.maw/config",
  mawDataDir: () => "/tmp/.maw",
  mawDataPath: (...parts: string[]) => ["/tmp", ".maw", ...parts].join("/"),
  mawStateDir: () => "/tmp/.maw/state",
  hostExec: async (cmd: string) => {
    commands.push(cmd);

    if (cmd.includes("#{session_name}:#{window_index}.#{pane_index}")) {
      if (throwParentAddress) throw new Error("parent unavailable");
      return "sess:1.0\n";
    }
    if (cmd.includes("#{session_name}:#{window_index}")) {
      if (throwWindowAddress) throw new Error("window unavailable");
      return "sess:1\n";
    }
    if (cmd.includes("tmux display-message") && cmd.includes("#{window_id}")) return "@win\n";
    if (cmd.includes("tmux list-panes") && cmd.includes("#{pane_id}|||#{pane_title}|||#{@maw_tile}")) {
      if (throwTilePaneList) throw new Error("list unavailable");
      return tilePaneList;
    }
    if (cmd.includes("tmux list-panes") && cmd.includes("#{pane_index}|||#{pane_id}|||#{pane_title}|||#{pane_top}")) {
      return swapPaneRows;
    }
    if (cmd.includes("tmux list-panes") && cmd.includes("#{pane_id}")) return plainPaneList;
    if (cmd.includes("tmux split-window")) return `%p${nextPane++}\n`;
    if (cmd === "git rev-parse --show-toplevel") {
      if (throwGitTop) throw new Error("not git");
      return "/tmp/maw-js\n";
    }
    if (cmd.includes("worktree list --porcelain")) return worktreeList;
    if (cmd.includes("branch -d")) {
      if (throwBranchDelete) throw new Error("not merged");
      return "";
    }
    return "";
  },
});

// Mock both ids: tile imports ../../../sdk, which resolves to src/sdk/index.ts.
// Earlier isolated tests can leak an index.ts mock that otherwise shadows this.
mock.module(join(root, "src/sdk"), sdkMock);
mock.module(join(root, "src/sdk/index.ts"), sdkMock);
mock.module(import.meta.resolve("../../src/sdk"), sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), sdkMock);
mock.module(new URL("../../src/sdk/index.ts", import.meta.url).pathname, sdkMock);

mock.module(join(root, "src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (idx: number) => `color-${idx}`,
  colorAnsi: () => 35,
  stylePaneBorder: async (paneId: string, label: string, color: string) => {
    borderCalls.push({ paneId, label, color });
  },
  enableBorderStatus: async (window: string) => {
    layoutCalls.push(`enable:${window}`);
  },
  applyTiledLayout: async (window: string) => {
    layoutCalls.push(`tile:${window}`);
  },
}));

mock.module(join(root, "src/core/transport/tmux-pane-lock"), () => ({
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));

const configMock = () => ({
  loadConfig: () => ({ commands: { codex: "codex --model fast" } }),
});
mock.module(join(root, "src/config"), configMock);
mock.module(join(root, "src/config/index.ts"), configMock);
mock.module(import.meta.resolve("../../src/config"), configMock);
mock.module(import.meta.resolve("../../src/config/index.ts"), configMock);

const { cmdTile, cmdTileClean, cmdTileSwap } = await import(
  "../../src/commands/plugins/tile/impl.ts?tile-impl-next-coverage"
);

const wtPath = "/tmp/maw-js.wt-1-tile-1";

function resetState() {
  commands = [];
  tilePaneList = "%lead|||leader|||\n";
  plainPaneList = "%lead\n";
  swapPaneRows = "0|||%lead|||lead|||0\n1|||%p1|||tile-1|||4\n2|||%p2|||tile-2|||14\n";
  worktreeList = "";
  nextPane = 1;
  throwParentAddress = false;
  throwWindowAddress = false;
  throwTilePaneList = false;
  throwGitTop = false;
  throwBranchDelete = false;
  layoutCalls = [];
  borderCalls = [];
  process.env.TMUX_PANE = "%lead";
  rmSync(wtPath, { recursive: true, force: true });
}

describe("tile impl next coverage", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetState();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalTileCmdSettle === undefined) delete process.env.MAW_TILE_CMD_SETTLE_MS;
    else process.env.MAW_TILE_CMD_SETTLE_MS = originalTileCmdSettle;
    rmSync(wtPath, { recursive: true, force: true });
  });

  test("validates counts and retile uses the active window without TMUX_PANE", async () => {
    await expect(cmdTile(-1)).rejects.toThrow("tile: count must be a non-negative integer");
    await expect(cmdTile(Number.POSITIVE_INFINITY)).rejects.toThrow("tile: count must be a non-negative integer");
    await expect(cmdTile(11)).rejects.toThrow("tile: max 10 panes (got 11)");

    delete process.env.TMUX_PANE;
    await cmdTile(0);

    expect(commands).toContain("tmux display-message -p '#{window_id}'");
    expect(layoutCalls).toContain("tile:@win");
    expect(logSpy).toHaveBeenCalledWith("\x1b[32m✓\x1b[0m tiled");
  });

  test("falls back when parent/window/count discovery fails before spawning a tile", async () => {
    throwParentAddress = true;
    throwWindowAddress = true;
    throwTilePaneList = true;
    plainPaneList = "%lead\n%p1\n";

    await cmdTile(1);

    const split = commands.find((cmd) => cmd.includes("tmux split-window"));
    expect(split).toContain("MAW_TILE_PARENT=");
    expect(split).toContain("%lead");
    expect(split).toContain("MAW_TILE_WINDOW=");
    expect(split).toContain("@win");
    expect(split).toContain("MAW_TILE_ROLE=");
    expect(split).toContain("lead-tile-1");
    expect(borderCalls).toEqual([{ paneId: "%p1", label: "lead-tile-1", color: "color-0" }]);
    expect(commands).toContain("tmux select-layout -t '@win' even-horizontal");
  });


  test("--cmd starts through the pane startup command instead of racing typed input", async () => {
    plainPaneList = "%lead\n%p1\n";

    await cmdTile(1, { cmd: "claude --agent-id reader-a@team --model sonnet" });

    const split = commands.find((cmd) => cmd.includes("tmux split-window"));
    expect(split).toContain("exec zsh -ic");
    expect(split).toContain("claude --agent-id reader-a@team --model sonnet");
    expect(commands.some(cmd => cmd.includes("tmux send-keys -t '%p1' -l"))).toBe(false);
    expect(commands).not.toContain("tmux send-keys -t '%p1' Enter");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cmd"));
  });

  test("--cmd avoids typed-input races across back-to-back single-pane spawns", async () => {
    const firstCmd = "claude --agent-id reader-a@team --model sonnet";
    const secondCmd = "claude --agent-id reader-b@team --model sonnet";

    plainPaneList = "%lead\n%p1\n";
    await cmdTile(1, { cmd: firstCmd });

    tilePaneList = "%lead|||leader|||\n%p1|||lead-tile-1|||1\n";
    plainPaneList = "%lead\n%p1\n%p2\n";
    await cmdTile(1, { cmd: secondCmd });

    const splits = commands.filter((cmd) => cmd.includes("tmux split-window"));
    expect(splits).toHaveLength(2);
    expect(splits[0]).toContain(firstCmd);
    expect(splits[1]).toContain(secondCmd);
    expect(splits.every(split => split.includes("exec zsh -ic"))).toBe(true);

    expect(commands.some(cmd => cmd.includes("tmux send-keys") && cmd.includes("-l") && cmd.includes("reader-"))).toBe(false);
    expect(borderCalls.map((call) => call.label)).toEqual(["sess-tile-1", "sess-tile-2"]);
  });

  test("engine command dispatch covers invalid and bounded tile command settle delays", async () => {
    process.env.MAW_TILE_CMD_SETTLE_MS = "0";
    plainPaneList = "%lead\n%p1\n";
    await cmdTile(1, { engine: "codex" });

    expect(commands).toContain("tmux send-keys -t '%p1' -l 'codex --model fast'");
    expect(commands).toContain("tmux send-keys -t '%p1' Enter");

    commands = [];
    nextPane = 1;
    process.env.MAW_TILE_CMD_SETTLE_MS = "not-a-number";
    await cmdTile(1, { engine: "codex" });

    expect(commands).toContain("tmux send-keys -t '%p1' -l 'codex --model fast'");
  });

  test("clean reports no-op when there are no tile panes and git discovery fails", async () => {
    throwGitTop = true;

    await cmdTileClean();

    expect(commands.some((cmd) => cmd.includes("tmux kill-pane"))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith("\x1b[90mno tile panes or worktrees to clean\x1b[0m");
  });

  test("clean keeps unmerged tile branches after removing matching worktrees", async () => {
    mkdirSync(wtPath, { recursive: true });
    expect(existsSync(wtPath)).toBe(true);
    throwBranchDelete = true;
    worktreeList = [
      "worktree /tmp/maw-js",
      "branch refs/heads/alpha",
      "",
      `worktree ${wtPath}`,
      "branch refs/heads/agents/1-tile-1",
      "",
    ].join("\n");

    await cmdTileClean();

    expect(commands).toContain("git -C '/tmp/maw-js' worktree remove '/tmp/maw-js.wt-1-tile-1' --force 2>/dev/null");
    expect(commands).toContain("git -C '/tmp/maw-js' branch -d 'agents/1-tile-1' 2>/dev/null");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("kept branch agents/1-tile-1"));
    expect(logSpy).toHaveBeenCalledWith("\x1b[32m✓\x1b[0m cleaned 1 tiles");
  });

  test("swap accepts explicit pane ids even when they are not in list-panes output", async () => {
    await cmdTileSwap("%unknown", "tile-2");

    expect(commands).toContain("tmux swap-pane -s '%unknown' -t '%p2'");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("%unknown ↔ tile-2"));
  });
});
