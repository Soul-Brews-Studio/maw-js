import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");
let commands: string[] = [];
let paneRows = "0|||%top|||top-title|||0\n1|||%mid|||mid-title|||10\n2|||%bottom|||bottom-title|||20\n";

mock.module(join(root, "src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("tmux display-message") && cmd.includes("#{window_id}")) return "@win\n";
    if (cmd.includes("#{pane_index}|||#{pane_id}|||#{pane_title}|||#{pane_top}")) return paneRows;
    return "";
  },
}));

mock.module(join(root, "src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: () => "green",
  colorAnsi: () => 32,
  stylePaneBorder: async () => {},
  enableBorderStatus: async () => {},
  applyTiledLayout: async () => {},
}));

mock.module(join(root, "src/core/transport/tmux-pane-lock"), () => ({
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));

const { cmdTileSwap } = await import("../../src/commands/plugins/tile/impl.ts?coverage-tile-final");

describe("tile swap final branch coverage", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    commands = [];
    paneRows = "0|||%top|||top-title|||0\n1|||%mid|||mid-title|||10\n2|||%bottom|||bottom-title|||20\n";
    delete process.env.TMUX_PANE;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("resolves top, bottom, index, prefix, empty, and same-pane swap branches", async () => {
    await cmdTileSwap("top", "bottom");
    expect(commands).toContain("tmux swap-pane -s '%top' -t '%bottom'");

    commands = [];
    await cmdTileSwap("1", "bottom");
    expect(commands).toContain("tmux swap-pane -s '%mid' -t '%bottom'");

    // The same-pane guard is only evaluated after both specs resolve; use two equivalent title specs.
    await expect(cmdTileSwap("mid-title", "mid")).rejects.toThrow("source and target are the same pane");

    await expect(cmdTileSwap("", "bottom")).rejects.toThrow("could not resolve pane ''");
    await expect(cmdTileSwap("top", "missing")).rejects.toThrow("could not resolve pane 'missing'");
  });
});
