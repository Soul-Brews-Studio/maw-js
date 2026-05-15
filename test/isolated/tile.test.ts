/**
 * Tile plugin tests — ISOLATED SUITE.
 *
 * Why isolated: tile shells through @maw-js/sdk/hostExec for tmux and git.
 * Bun's mock.module is process-global, so this belongs under test/isolated
 * rather than the main suite.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let commands: string[] = [];
let nextPane = 1;
let paneList = "";
let worktreeList = "";

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.includes("tmux display-message")) return "@win\n";
    if (cmd.includes("tmux split-window")) return `%p${nextPane++}\n`;
    if (cmd.includes("tmux list-panes")) return paneList;
    if (cmd.includes("git rev-parse --show-toplevel")) return "/tmp/maw-js\n";
    if (cmd.includes("git -C '/tmp/maw-js' worktree list")) return worktreeList;

    return "";
  },
}));

const { cmdTile, cmdTileClean, cmdTileSwap } = await import("../../src/commands/plugins/tile/impl");

beforeEach(() => {
  commands = [];
  nextPane = 1;
  paneList = "";
  worktreeList = "";
  process.env.TMUX_PANE = "%lead";
});

describe("tile plugin layout", () => {
  test("2-3 spawned tiles use main-vertical, leaving lead pane full-height on the left", async () => {
    await cmdTile(2);

    expect(commands).toContain("tmux split-window -t '%lead' -h -P -F '#{pane_id}' 'exec zsh'");
    expect(commands).toContain("tmux split-window -t '%p1' -h -P -F '#{pane_id}' 'exec zsh'");
    expect(commands).toContain("tmux select-layout -t '@win' main-vertical");
    expect(commands).not.toContain("tmux select-layout -t '@win' tiled");
  });

  test("one spawned tile keeps the simple side-by-side split", async () => {
    await cmdTile(1);

    expect(commands).toContain("tmux select-layout -t '@win' even-horizontal");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });

  test("incremental tile spawn chooses layout from total panes, not new spawn count", async () => {
    paneList = "4\n";

    await cmdTile(1);

    expect(commands).toContain("tmux list-panes -t '@win' | wc -l");
    expect(commands).toContain("tmux select-layout -t '@win' main-vertical");
    expect(commands).not.toContain("tmux select-layout -t '@win' even-horizontal");
  });

  test("four or more spawned tiles use the tiled grid", async () => {
    await cmdTile(4);

    expect(commands).toContain("tmux select-layout -t '@win' tiled");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });

  test("incremental tile spawn switches to tiled grid once total pane count exceeds four", async () => {
    paneList = "5\n";

    await cmdTile(1);

    expect(commands).toContain("tmux select-layout -t '@win' tiled");
    expect(commands).not.toContain("tmux select-layout -t '@win' even-horizontal");
    expect(commands).not.toContain("tmux select-layout -t '@win' main-vertical");
  });
});

describe("tile clean", () => {
  test("kills every non-lead pane in the current window without trusting pane titles", async () => {
    paneList = [
      "%lead leader-title",
      "%p1 overwritten-by-agent",
      "%p2 zsh",
    ].join("\n");

    await cmdTileClean();

    expect(commands).toContain("tmux kill-pane -t '%p1'");
    expect(commands).toContain("tmux kill-pane -t '%p2'");
    expect(commands).not.toContain("tmux kill-pane -t '%lead'");
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
