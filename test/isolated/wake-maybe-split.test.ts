import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let hostExecCalls: string[] = [];
let listPanesResponse = "3\n";
let tileMarkerResponse = "";
let paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";
let refreshClientThrows = false;
let paneCommandResponse = "zsh";
let paneSessionWindowResponse = "";
let paneClientTtyResponse = "/dev/ttys001";
let newWindowResponse = "";

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("session_name") && cmd.includes("window_name")) return paneSessionWindowResponse;
    if (cmd.includes("client_tty")) return paneClientTtyResponse;
    if (cmd.includes("pane_current_command")) return paneCommandResponse;
    if (cmd.includes("refresh-client")) {
      if (refreshClientThrows) throw new Error("refresh unsupported");
      return "";
    }
    if (cmd.includes("new-window")) return newWindowResponse;
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
  const originalAllowClaudeSplit = process.env.MAW_ALLOW_CLAUDE_SPLIT;
  const originalAllowSelfBring = process.env.MAW_ALLOW_SELF_BRING;
  const originalForceSplit = process.env.MAW_FORCE_SPLIT;
  const originalSafeSplit = process.env.MAW_SAFE_SPLIT;

  beforeEach(() => {
    hostExecCalls = [];
    listPanesResponse = "3\n";
    tileMarkerResponse = "";
    paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";
    refreshClientThrows = false;
    paneCommandResponse = "zsh";
    paneSessionWindowResponse = "";
    paneClientTtyResponse = "/dev/ttys001";
    newWindowResponse = "";
    process.env.TMUX = "/tmp/tmux-501/default,123,0";
    process.env.TMUX_PANE = "%42";
    delete process.env.MAW_ALLOW_CLAUDE_SPLIT;
    delete process.env.MAW_ALLOW_SELF_BRING;
    delete process.env.MAW_FORCE_SPLIT;
    delete process.env.MAW_SAFE_SPLIT;
  });

  test("does nothing when split is not requested", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);
  });

  test("splits current pane and attaches target without importing removed split plugin", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(7);
    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window");
    expect(hostExecCalls[2]).toContain("-t '%42'");
    expect(hostExecCalls[2]).toContain("-h -l 50%");
    expect(hostExecCalls[2]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[2]).toContain("20-homekeeper:homekeeper-oracle");
    expect(hostExecCalls[3]).toContain("tmux show-options -p -t '%42' -v @maw_tile");
    expect(hostExecCalls[4]).toContain("tmux list-panes -t '%42'");
    expect(hostExecCalls[5]).toContain("tmux select-layout -t '%42' main-vertical");
    expect(hostExecCalls[6]).toBe("tmux refresh-client -S");
  });

  test("does not reset layout when split leaves only two panes", async () => {
    listPanesResponse = "2\n";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(6);
    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window");
    expect(hostExecCalls[3]).toContain("tmux show-options -p -t '%42' -v @maw_tile");
    expect(hostExecCalls[4]).toContain("tmux list-panes -t '%42'");
    expect(hostExecCalls[5]).toBe("tmux refresh-client -S");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux select-layout"))).toBe(false);
  });

  test("preserves horizontal split when splitting from a maw tile pane", async () => {
    tileMarkerResponse = "1\n";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(5);
    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window");
    expect(hostExecCalls[2]).toContain("-t '%42'");
    expect(hostExecCalls[2]).toContain("-h -l 50%");
    expect(hostExecCalls[3]).toContain("tmux show-options -p -t '%42' -v @maw_tile");
    expect(hostExecCalls[4]).toBe("tmux refresh-client -S");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux select-layout"))).toBe(false);
  });


  test("MAW_SAFE_SPLIT opens a background tab from Claude-like caller panes (#1836)", async () => {
    paneCommandResponse = "claude";
    newWindowResponse = "@88";
    process.env.MAW_SAFE_SPLIT = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toBe("tmux send-keys -R -t '%42' C-l");
    expect(hostExecCalls[3]).toBe("tmux clear-history -t '%42'");
    expect(hostExecCalls[9]).toContain("tmux new-window -P -F '#{window_id}' -d");
    expect(hostExecCalls[9]).toContain("-n 'bring-homekeeper-oracle'");
    expect(hostExecCalls[9]).toContain("unset TMUX");
    expect(hostExecCalls[9]).toContain("clear 2>/dev/null");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
  });

  test("same-session target from Claude-like panes refuses nested split instead of attaching", async () => {
    paneCommandResponse = "claude";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("50-mawjs:mawjs-features", { split: true });

    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("attach-session"))).toBe(false);
  });

  test("explicit --to inside the same session refuses nested split (#1827/#1836)", async () => {
    paneCommandResponse = "claude";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("50-mawjs:mawjs-features", {
      split: true,
      splitTarget: "50-mawjs:mawjs-oracle",
    });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '50-mawjs:mawjs-oracle' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '50-mawjs:mawjs-oracle' '#{pane_current_command}'");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("link-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("attach-session"))).toBe(false);
  });

  test("splits cross-session targets from Claude-like panes by default (#1836)", async () => {
    paneCommandResponse = "claude";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window -t '%42' -h -l 50%");
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
  });

  test("uses a specific split target when --to contains a session:window", async () => {
    await maybeSplit("50-mawjs:mawjs-features", {
      split: true,
      splitTarget: "50-mawjs:maw-js-1816",
    });

    expect(hostExecCalls[0]).toContain("-t '50-mawjs:maw-js-1816'");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window -t '50-mawjs:maw-js-1816' -h -l 50%");
  });


  test("can force split from Claude-like caller panes with MAW_ALLOW_CLAUDE_SPLIT", async () => {
    paneCommandResponse = "claude";
    process.env.MAW_ALLOW_CLAUDE_SPLIT = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("tmux split-window");
    expect(hostExecCalls.some(cmd => cmd.includes("pane_current_command"))).toBe(false);
  });

  test("can split without TMUX_PANE by omitting anchor", async () => {
    delete process.env.TMUX_PANE;

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(4);
    expect(hostExecCalls[0]).not.toContain("-t '%");
    expect(hostExecCalls[0]).toContain("tmux split-window -h -l 50%");
    expect(hostExecCalls[1]).toContain("tmux list-panes ");
    expect(hostExecCalls[2]).toContain("tmux select-layout main-vertical");
    expect(hostExecCalls[3]).toBe("tmux refresh-client -S");
  });

  test("uses tiled layout after split when pane count is high", async () => {
    listPanesResponse = "5\n";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[5]).toContain("tmux select-layout -t '%42' tiled");
    expect(hostExecCalls[6]).toBe("tmux refresh-client -S");
  });

  test("redraw nudge failure does not fail the split", async () => {
    refreshClientThrows = true;

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls.at(-1)).toBe("tmux refresh-client -S");
  });

  test("finds the top-right tile pane, excluding the caller", async () => {
    const pane = await findTopRightPane("%42");

    expect(pane).toBe("%43");
  });

  test("replaces the top-right pane for explicit bring mode", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });

    expect(hostExecCalls).toHaveLength(2);
    expect(hostExecCalls[0]).toContain("tmux list-panes -t '%42' -F");
    expect(hostExecCalls[1]).toContain("tmux respawn-pane -k -t '%43'");
    expect(hostExecCalls[1]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[1]).toContain("20-homekeeper:homekeeper-oracle");
  });

  test("falls back to a background tab when explicit bring mode has no replacement pane", async () => {
    paneGeometryResponse = "%42|0|0|\n";

    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });

    expect(hostExecCalls).toHaveLength(2);
    expect(hostExecCalls[0]).toContain("tmux list-panes -t '%42' -F");
    expect(hostExecCalls[1]).toContain("tmux new-window -P -F '#{window_id}' -d");
    expect(hostExecCalls[1]).toContain("-n 'bring-homekeeper-oracle'");
  });

  test("can force the old background-tab behavior", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true, tab: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toContain("tmux new-window -P -F '#{window_id}' -d");
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
    if (originalAllowClaudeSplit === undefined) delete process.env.MAW_ALLOW_CLAUDE_SPLIT;
    else process.env.MAW_ALLOW_CLAUDE_SPLIT = originalAllowClaudeSplit;
    if (originalAllowSelfBring === undefined) delete process.env.MAW_ALLOW_SELF_BRING;
    else process.env.MAW_ALLOW_SELF_BRING = originalAllowSelfBring;
    if (originalForceSplit === undefined) delete process.env.MAW_FORCE_SPLIT;
    else process.env.MAW_FORCE_SPLIT = originalForceSplit;
    if (originalSafeSplit === undefined) delete process.env.MAW_SAFE_SPLIT;
    else process.env.MAW_SAFE_SPLIT = originalSafeSplit;
  });
});
