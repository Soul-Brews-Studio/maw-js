/**
 * Tile plugin tests — ISOLATED SUITE.
 *
 * Why isolated: tile shells through @maw-js/sdk/hostExec for tmux and git.
 * Bun's mock.module is process-global, so this belongs under test/isolated
 * rather than the main suite.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

let commands: string[] = [];
let nextPane = 1;
let paneList = "";
let worktreeList = "";
let worktreeGlobList = "";

function generatedPaneIds(): string[] {
  return Array.from({ length: nextPane - 1 }, (_, i) => `%p${i + 1}`);
}

function paneIdsFromPaneList(): string[] {
  return paneList.split("\n")
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|||");
      if (parts[0]?.startsWith("%")) return parts[0];
      if (parts[1]?.startsWith("%")) return parts[1];
      return line.split(" ")[0];
    })
    .filter(Boolean);
}

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  FLEET_DIR: "/tmp/fleet",
  curlFetch: async () => ({ ok: false, status: 404, text: async () => "" }),
  tmux: {},
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.includes("#{session_name}:#{window_index}.#{pane_index}")) return "sess:1.0\n";
    if (cmd.includes("#{session_name}:#{window_index}")) return "sess:1\n";
    if (cmd.includes("tmux display-message")) return "@win\n";
    if (cmd.includes("tmux split-window")) return `%p${nextPane++}\n`;
    if (cmd.includes("tmux list-panes") && cmd.includes("|||")) {
      return paneList || "%lead|||lead|||\n";
    }
    if (cmd.includes("tmux list-panes") && cmd.includes("#{pane_id}")) {
      const ids = paneIdsFromPaneList();
      return [...(ids.length ? ids : ["%lead"]), ...generatedPaneIds()].join("\n") + "\n";
    }
    if (cmd.includes("git rev-parse --show-toplevel")) return "/tmp/maw-js\n";
    if (cmd.includes("ls -d") && cmd.includes(".wt-*")) return worktreeGlobList;
    if (cmd.includes("git -C '/tmp/maw-js' worktree list")) return worktreeList;
    if (cmd.includes("show-ref --verify")) throw new Error("missing branch");

    return "";
  },
}));

const { cmdTile, cmdTileClean, cmdTileSwap } = await import("../../src/commands/plugins/tile/impl");

beforeEach(() => {
  commands = [];
  nextPane = 1;
  paneList = "";
  worktreeList = "";
  worktreeGlobList = "";
  rmSync("/tmp/maw-js.wt-1-tile-1", { recursive: true, force: true });
  rmSync("/tmp/maw-js.wt-2-sess-tile-1", { recursive: true, force: true });
  rmSync("/tmp/maw-js.wt-explore-1234", { recursive: true, force: true });
  process.env.TMUX_PANE = "%lead";
});

describe("tile plugin layout", () => {
  test("2-3 total spawned tiles use main-vertical, leaving lead pane full-height on the left", async () => {
    await cmdTile(2);

    const splitCommands = commands.filter(cmd => cmd.includes("tmux split-window"));
    expect(splitCommands[0]).toContain("MAW_TILE_PARENT='");
    expect(splitCommands[0]).toContain("MAW_TILE_ROLE='\\''sess-tile-1'\\''");
    expect(splitCommands[0]).toContain("MAW_TILE_TOTAL='\\''2'\\''");
    expect(splitCommands[1]).toContain("MAW_TILE_ROLE='\\''sess-tile-2'\\''");
    expect(commands).toContain("tmux select-layout -t '@win' main-vertical");
    expect(commands).not.toContain("tmux select-layout -t '@win' tiled");
  });

  test("one spawned tile keeps the simple side-by-side split when it creates two total panes", async () => {
    await cmdTile(1);

    expect(commands).toContain("tmux select-layout -t '@win' even-horizontal");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });

  test("incremental spawn selects layout from total panes after spawn, not the requested spawn count", async () => {
    paneList = [
      "%lead|||lead|||",
      "%p-existing-1|||tile-1|||1",
      "%p-existing-2|||tile-2|||1",
    ].join("\n");

    await cmdTile(1);

    const splitCommand = commands.find(cmd => cmd.includes("tmux split-window"));
    expect(splitCommand).toContain("MAW_TILE_ROLE='\\''sess-tile-3'\\''");
    expect(splitCommand).toContain("MAW_TILE_INDEX='\\''3'\\''");
    expect(splitCommand).toContain("MAW_TILE_TOTAL='\\''3'\\''");
    expect(commands).toContain("tmux select-layout -t '@win' main-vertical");
    expect(commands).not.toContain("tmux select-layout -t '@win' even-horizontal");
  });

  test("five or more total panes use the tiled grid", async () => {
    await cmdTile(4);

    expect(commands).toContain("tmux select-layout -t '@win' tiled");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });

  test("incremental tile spawn switches to tiled grid once total pane count exceeds four", async () => {
    paneList = [
      "%lead|||lead|||",
      "%p-existing-1|||tile-1|||1",
      "%p-existing-2|||tile-2|||1",
      "%p-existing-3|||tile-3|||1",
    ].join("\n");

    await cmdTile(1);

    expect(commands).toContain("tmux select-layout -t '@win' tiled");
    expect(commands).not.toContain("tmux select-layout -t '@win' even-horizontal");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });
});

describe("tile plugin spawn metadata", () => {
  test("passes parent/window identity and tile role env to engine commands", async () => {
    await cmdTile(1, { engine: "claude" });

    const splitCommand = commands.find(cmd => cmd.includes("tmux split-window"));
    expect(splitCommand).toContain("MAW_TILE_PARENT='\\''sess:1.0'\\''");
    expect(splitCommand).toContain("MAW_TILE_ROLE='\\''sess-tile-1'\\''");
    expect(splitCommand).toContain("MAW_TILE_INDEX='\\''1'\\''");
    expect(splitCommand).toContain("MAW_TILE_TOTAL='\\''1'\\''");
    expect(splitCommand).toContain("MAW_TILE_WINDOW='\\''sess:1'\\''");
    expect(splitCommand).toContain("; claude; exec zsh");
    expect(commands).toContain("tmux set-option -p -t '%p1' @maw_tile '1'");
    expect(commands).toContain("tmux set-option -p -t '%p1' @maw_tile_parent 'sess:1.0'");
    expect(commands).toContain("tmux set-option -p -t '%p1' @maw_tile_role 'sess-tile-1'");
  });



  test("starts spawned shells in --path and runs --cmd before returning to zsh", async () => {
    await cmdTile(2, { path: "/tmp", cmd: "bun test", shell: true });

    const splitCommands = commands.filter(cmd => cmd.includes("tmux split-window"));
    expect(splitCommands).toHaveLength(2);
    for (const splitCommand of splitCommands) {
      expect(splitCommand).toContain("/tmp");
      expect(splitCommand).toContain("|| exit $?; export");
      expect(splitCommand).toContain("; bun test; exec zsh");
      expect(splitCommand).toContain("MAW_TILE_PARENT='");
    }
  });



  test("rejects invalid --path before spawning panes", async () => {
    const missing = "/tmp/maw-js-missing-tile-path";
    rmSync(missing, { recursive: true, force: true });

    await expect(cmdTile(1, { path: missing })).rejects.toThrow("tile: path does not exist");
    expect(commands).toEqual([]);
  });

  test("uses scoped tile roles for worktree names and branches", async () => {
    await cmdTile(1, { wt: true });

    expect(commands).toContain("git -C '/tmp/maw-js' worktree add '/tmp/maw-js.wt-1-sess-tile-1' -b 'agents/1-sess-tile-1'");
    const splitCommand = commands.find(cmd => cmd.includes("tmux split-window"));
    expect(splitCommand).toContain("/tmp/maw-js.wt-1-sess-tile-1");
    expect(splitCommand).toContain("MAW_TILE_ROLE='\\''sess-tile-1'\\''");
  });

  test("creates one named --wt worktree and opens all tile panes as blank shells inside it", async () => {
    await cmdTile(3, { wt: "explore-1234" });

    expect(commands).toContain("git -C '/tmp/maw-js' worktree add '/tmp/maw-js.wt-explore-1234' -b 'agents/explore-1234'");
    const splitCommands = commands.filter(cmd => cmd.includes("tmux split-window"));
    expect(splitCommands).toHaveLength(3);
    for (const splitCommand of splitCommands) {
      expect(splitCommand).toContain("/tmp/maw-js.wt-explore-1234");
      expect(splitCommand).toContain("exec zsh");
      expect(splitCommand).not.toContain("claude");
    }
  });

  test("reuses named --wt worktrees and resolves --path relative to that worktree", async () => {
    mkdirSync("/tmp/maw-js.wt-explore-1234/src", { recursive: true });
    worktreeGlobList = "/tmp/maw-js.wt-explore-1234\n";

    await cmdTile(2, { wt: "explore-1234", path: "src" });

    expect(commands.some(cmd => cmd.includes("worktree add '/tmp/maw-js.wt-explore-1234'"))).toBe(false);
    const splitCommands = commands.filter(cmd => cmd.includes("tmux split-window"));
    expect(splitCommands).toHaveLength(2);
    expect(splitCommands.every(cmd => cmd.includes("/tmp/maw-js.wt-explore-1234/src"))).toBe(true);
  });
});

describe("tile clean", () => {
  test("kills only panes marked or titled as tile panes in the current window", async () => {
    paneList = [
      "%lead|||leader-title|||",
      "%p1|||tile-1|||1",
      "%p2|||zsh|||",
      "%p3|||tile-3 🌳|||",
      "%p4|||sess-tile-4 🌳|||",
    ].join("\n");

    await cmdTileClean();

    expect(commands).toContain("tmux kill-pane -t '%p1'");
    expect(commands).toContain("tmux kill-pane -t '%p3'");
    expect(commands).toContain("tmux kill-pane -t '%p4'");
    expect(commands).not.toContain("tmux kill-pane -t '%p2'");
    expect(commands).not.toContain("tmux kill-pane -t '%lead'");
  });

  test("removes tile worktrees and safely deletes matching tile branches", async () => {
    mkdirSync("/tmp/maw-js.wt-1-tile-1", { recursive: true });
    mkdirSync("/tmp/maw-js.wt-2-sess-tile-1", { recursive: true });
    worktreeList = [
      "worktree /tmp/maw-js",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/maw-js.wt-1-tile-1",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/agents/1-tile-1",
      "",
      "worktree /tmp/maw-js.wt-2-sess-tile-1",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/agents/2-sess-tile-1",
      "",
      "worktree /tmp/maw-js.wt-3-task",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/agents/3-task",
    ].join("\n");

    await cmdTileClean();

    expect(commands).toContain("git -C '/tmp/maw-js' worktree remove '/tmp/maw-js.wt-1-tile-1' --force 2>/dev/null");
    expect(commands).toContain("git -C '/tmp/maw-js' branch -d 'agents/1-tile-1' 2>/dev/null");
    expect(commands).toContain("git -C '/tmp/maw-js' worktree remove '/tmp/maw-js.wt-2-sess-tile-1' --force 2>/dev/null");
    expect(commands).toContain("git -C '/tmp/maw-js' branch -d 'agents/2-sess-tile-1' 2>/dev/null");
    expect(commands.some(cmd => cmd.includes("agents/3-task"))).toBe(false);

    rmSync("/tmp/maw-js.wt-1-tile-1", { recursive: true, force: true });
    rmSync("/tmp/maw-js.wt-2-sess-tile-1", { recursive: true, force: true });
  });
});

describe("tile swap", () => {
  beforeEach(() => {
    paneList = [
      "0|||%lead|||lead|||0",
      "1|||%p1|||tile-1|||4",
      "2|||%p2|||tile-2 🌳|||14",
    ].join("\n");
  });

  test("swaps panes by current-window pane index", async () => {
    await cmdTileSwap("1", "2");

    expect(commands).toContain("tmux swap-pane -s '%p1' -t '%p2'");
  });

  test("swaps panes by tile title prefix", async () => {
    await cmdTileSwap("tile-1", "tile-2");

    expect(commands).toContain("tmux swap-pane -s '%p1' -t '%p2'");
  });

  test("swaps top and bottom panes by pane_top", async () => {
    await cmdTileSwap("top", "bottom");

    expect(commands).toContain("tmux swap-pane -s '%lead' -t '%p2'");
  });

  test("rejects unresolved pane targets", async () => {
    await expect(cmdTileSwap("missing", "tile-2")).rejects.toThrow(/could not resolve pane 'missing'/);
  });
});
