import { beforeEach, describe, expect, mock, test } from "bun:test";

let hostExecCalls: string[] = [];

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [
    {
      name: "47-mawjs",
      windows: [{ index: 0 }, { index: 1 }],
    },
  ],
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("list-panes -t '47-mawjs:0'")) return "0\n1\n2\n";
    if (cmd.includes("list-panes -a -F")) {
      return "%101|||47-mawjs:1.0|||codex-headless-demo-layout|||tile-1|||/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle.wt-7-codex-headless";
    }
    if (cmd.includes("kill-pane -t '%101'")) return "";
    if (cmd.includes("kill-pane -t '47-mawjs:0.2'")) return "";
    throw new Error(`unexpected command: ${cmd}`);
  },
}));

const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl");

describe("kill --pane range validation (#1441)", () => {
  beforeEach(() => {
    hostExecCalls = [];
  });

  test("errors when pane index is out of range instead of silently falling back", async () => {
    await expect(cmdKill("mawjs", { pane: 99 })).rejects.toThrow(
      "pane 99 does not exist in window 47-mawjs:0 (valid: 0, 1, 2)",
    );

    expect(hostExecCalls.some((c) => c.includes("kill-pane"))).toBeFalse();
    expect(hostExecCalls[0]).toContain("list-panes -t '47-mawjs:0'");
  });

  test("kills the requested pane when index is valid", async () => {
    await expect(cmdKill("mawjs", { pane: 2 })).resolves.toBeUndefined();

    expect(hostExecCalls[0]).toContain("list-panes -t '47-mawjs:0'");
    expect(hostExecCalls[1]).toContain("kill-pane -t '47-mawjs:0.2'");
  });

  test("falls back to pane-title/worktree aliases when no session matches", async () => {
    await expect(cmdKill("mawjs-codex-headless")).resolves.toBeUndefined();

    expect(hostExecCalls[0]).toContain("list-panes -a -F");
    expect(hostExecCalls[1]).toContain("kill-pane -t '%101'");
  });
});
