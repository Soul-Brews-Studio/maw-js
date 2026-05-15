import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let hostExecCalls: string[] = [];
let listPanesResponse = "3\n";
let tileMarkerResponse = "";
let paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("show-options") && cmd.includes("@maw_tile")) return tileMarkerResponse;
    if (cmd.includes("list-panes") && cmd.includes("#{pane_id}|#{pane_top}|#{pane_left}|#{@maw_tile}")) {
      return paneGeometryResponse;
    }
    if (cmd.includes("list-panes")) return listPanesResponse;
    return "";
  },
}));

const { findTopRightPane, maybeOpenWindow, maybeSplit } = await import("../../src/commands/shared/wake-maybe-split");

describe("wake maybeSplit", () => {
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;

  beforeEach(() => {
    hostExecCalls = [];
    listPanesResponse = "3\n";
    tileMarkerResponse = "";
    paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";
    process.env.TMUX = "/tmp/tmux-501/default,123,0";
    process.env.TMUX_PANE = "%42";
  });

  test("does nothing when split is not requested", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);
  });

  test("splits current pane and attaches target without importing removed split plugin", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(4);
    expect(hostExecCalls[0]).toContain("tmux split-window");
    expect(hostExecCalls[0]).toContain("-t '%42'");
    expect(hostExecCalls[0]).toContain("-h -l 50%");
    expect(hostExecCalls[0]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[0]).toContain("20-homekeeper:homekeeper-oracle");
    expect(hostExecCalls[1]).toContain("tmux show-options -p -t '%42' -v @maw_tile");
    expect(hostExecCalls[2]).toContain("tmux list-panes -t '%42'");
    expect(hostExecCalls[3]).toContain("tmux select-layout -t '%42' main-vertical");
  });

  test("preserves horizontal split when splitting from a maw tile pane", async () => {
    tileMarkerResponse = "1\n";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(2);
    expect(hostExecCalls[0]).toContain("tmux split-window");
    expect(hostExecCalls[0]).toContain("-t '%42'");
    expect(hostExecCalls[0]).toContain("-h -l 50%");
    expect(hostExecCalls[1]).toContain("tmux show-options -p -t '%42' -v @maw_tile");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux select-layout"))).toBe(false);
  });

  test("can split without TMUX_PANE by omitting anchor", async () => {
    delete process.env.TMUX_PANE;

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(3);
    expect(hostExecCalls[0]).not.toContain("-t '%");
    expect(hostExecCalls[0]).toContain("tmux split-window -h -l 50%");
    expect(hostExecCalls[1]).toContain("tmux list-panes ");
    expect(hostExecCalls[2]).toContain("tmux select-layout main-vertical");
  });

  test("uses tiled layout after split when pane count is high", async () => {
    listPanesResponse = "5\n";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[3]).toContain("tmux select-layout -t '%42' tiled");
  });

  test("finds the top-right tile pane, excluding the caller", async () => {
    const pane = await findTopRightPane("%42");

    expect(pane).toBe("%43");
  });

  test("replaces the top-right pane for bring default mode", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });

    expect(hostExecCalls).toHaveLength(2);
    expect(hostExecCalls[0]).toContain("tmux list-panes -t '%42' -F");
    expect(hostExecCalls[1]).toContain("tmux respawn-pane -k -t '%43'");
    expect(hostExecCalls[1]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[1]).toContain("20-homekeeper:homekeeper-oracle");
  });

  test("falls back to a background tab when no replacement pane exists", async () => {
    paneGeometryResponse = "%42|0|0|\n";

    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });

    expect(hostExecCalls).toHaveLength(2);
    expect(hostExecCalls[0]).toContain("tmux list-panes -t '%42' -F");
    expect(hostExecCalls[1]).toContain("tmux new-window -d");
    expect(hostExecCalls[1]).toContain("-n 'bring-homekeeper-oracle'");
  });

  test("can force the old background-tab behavior", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true, tab: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toContain("tmux new-window -d");
  });

  test("does not open a window when bring is not requested", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);
  });

  afterAll(() => {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalPane;
  });
});
