import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let hostExecCalls: string[] = [];

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "";
  },
}));

const { maybeOpenWindow, maybeSplit } = await import("../../src/commands/shared/wake-maybe-split");

describe("wake maybeSplit", () => {
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;

  beforeEach(() => {
    hostExecCalls = [];
    process.env.TMUX = "/tmp/tmux-501/default,123,0";
    process.env.TMUX_PANE = "%42";
  });

  test("does nothing when split is not requested", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);
  });

  test("splits current pane and attaches target without importing removed split plugin", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toContain("tmux split-window");
    expect(hostExecCalls[0]).toContain("-t '%42'");
    expect(hostExecCalls[0]).toContain("-h -l 50%");
    expect(hostExecCalls[0]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[0]).toContain("20-homekeeper:homekeeper-oracle");
  });

  test("can split without TMUX_PANE by omitting anchor", async () => {
    delete process.env.TMUX_PANE;

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).not.toContain("-t '%");
    expect(hostExecCalls[0]).toContain("tmux split-window -h -l 50%");
  });

  test("opens a new tmux window/tab for bring default mode", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toContain("tmux new-window");
    expect(hostExecCalls[0]).toContain("-n 'bring-homekeeper-oracle'");
    expect(hostExecCalls[0]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[0]).toContain("20-homekeeper:homekeeper-oracle");
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
