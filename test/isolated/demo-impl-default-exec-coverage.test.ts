import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let execCalls: string[] = [];
let paneSnapshots: string[] = [];
let rejectCleanup = false;
let rejectListPanes = false;

mock.module("maw-js/core/transport/ssh", () => ({
  hostExec: async (cmd: string) => {
    execCalls.push(cmd);
    if (cmd === "tmux list-panes -a -F #{pane_id}") {
      if (rejectListPanes) throw new Error("list panes failed");
      return paneSnapshots.shift() ?? "%base\n%agent1\n%agent2";
    }
    if (rejectCleanup && (cmd.startsWith("tmux kill-pane") || cmd.startsWith("rm -f "))) {
      throw new Error("cleanup failed");
    }
    return "";
  },
}));

const { cmdDemo } = await import("../../src/vendor/mpr-plugins/demo/impl.ts?demo-impl-default-exec-coverage");

const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const originalWrite = process.stdout.write;

let output = "";

beforeEach(() => {
  output = "";
  execCalls = [];
  paneSnapshots = [];
  rejectCleanup = false;
  rejectListPanes = false;
  process.env.TMUX = "/tmp/tmux-100/default,100,0";
  delete process.env.TMUX_PANE;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  process.stdout.write = originalWrite;
});

describe("demo impl default exec coverage", () => {
  test("cmdDemo uses hostExec defaults, caller fallback target, default sleep, and swallowed cleanup failures", async () => {
    rejectCleanup = true;
    paneSnapshots = [
      "%base",
      "%base\n%agent1",
      "%base\n%agent1",
      "%base\n%agent1\n%agent2",
    ];

    await cmdDemo({ fast: true });

    expect(execCalls.filter((cmd) => cmd.startsWith("chmod +x '/tmp/maw-demo-"))).toHaveLength(2);
    expect(execCalls.some((cmd) => cmd.includes("tmux split-window -t ':.' -h -l 50%"))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes("tmux split-window -t '%agent1' -v -l 50%"))).toBe(true);
    expect(execCalls).toContain("tmux kill-pane -t '%agent2'");
    expect(execCalls).toContain("tmux kill-pane -t '%agent1'");
    expect(execCalls.filter((cmd) => cmd.startsWith("rm -f '/tmp/maw-demo-"))).toHaveLength(2);
    expect(output).toContain("agent-1 spawned (%agent1)");
    expect(output).toContain("agent-2 spawned (%agent2)");
    expect(output).toContain("✓ demo complete.");
  });

  test("cmdDemo default hostExec path falls back when pane listing fails", async () => {
    rejectListPanes = true;

    await cmdDemo({ fast: true, sleep: async () => undefined });

    expect(execCalls.some((cmd) => cmd.includes("tmux split-window -t ':.' -h -l 50%"))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes("tmux split-window -t ':.' -v -l 50%"))).toBe(true);
    expect(execCalls.some((cmd) => cmd.startsWith("tmux kill-pane"))).toBe(false);
    expect(output).toContain("agent-1 spawned");
    expect(output).toContain("agent-2 spawned");
  });
});
