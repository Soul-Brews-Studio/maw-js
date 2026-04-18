import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

// Regression for #365: `maw bud --split` silently no-ops on 2nd+ bud from
// same parent. Root cause: cmdSplit emitted `tmux split-window` without -t,
// so tmux targeted the currently-active pane — which drifted after the first
// split. Fix: anchor every split to the caller's TMUX_PANE so buds cascade.

let commands: string[] = [];
const mockExec = async (cmd: string, _host?: string) => {
  commands.push(cmd);
  return "";
};

mock.module("../../src/config", () =>
  mockConfigModule(() => ({ host: "local" })),
);
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: mockExec,
  ssh: mockExec,
  listSessions: async () => [
    { name: "05-volt", windows: [{ index: 0, name: "main" }] },
    { name: "106-tennis-court-v2", windows: [{ index: 0, name: "main" }] },
    { name: "107-volt-pv", windows: [{ index: 0, name: "main" }] },
  ],
}));

const { cmdSplit } = await import("../../src/commands/plugins/split/impl");

beforeEach(() => {
  commands = [];
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  process.env.TMUX_PANE = "%42";
});

afterEach(() => {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
});

describe("cmdSplit cascade (#365)", () => {
  test("anchors split to caller's TMUX_PANE", async () => {
    await cmdSplit("106-tennis-court-v2");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("-t '%42'");
    expect(commands[0]).toMatch(
      /^tmux split-window -t '%42' -h -l 50% "TMUX= tmux attach-session -t 106-tennis-court-v2:0"$/,
    );
  });

  test("two sequential splits from same caller both target same pane (cascade)", async () => {
    // First bud: splits parent's pane %42 into two panes
    await cmdSplit("106-tennis-court-v2");
    // Second bud: MUST still target %42, not the newly-active child pane
    await cmdSplit("107-volt-pv");

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("-t '%42'");
    expect(commands[1]).toContain("-t '%42'");
    // Both splits anchored to caller's pane — this is the cascade.
    expect(commands[0]).toContain("106-tennis-court-v2");
    expect(commands[1]).toContain("107-volt-pv");
  });

  test("passes --vertical + --pct through with target", async () => {
    await cmdSplit("106-tennis-court-v2", { vertical: true, pct: 30 });
    expect(commands[0]).toMatch(
      /^tmux split-window -t '%42' -v -l 30% "TMUX= tmux attach-session -t 106-tennis-court-v2:0"$/,
    );
  });

  test("--no-attach with target runs bash in new pane", async () => {
    await cmdSplit("106-tennis-court-v2", { noAttach: true });
    expect(commands[0]).toBe(`tmux split-window -t '%42' -h -l 50% "bash"`);
  });

  test("falls back (no -t) when TMUX_PANE is unset (defensive)", async () => {
    delete process.env.TMUX_PANE;
    await cmdSplit("106-tennis-court-v2");
    expect(commands[0]).not.toContain("-t '%");
    expect(commands[0]).toMatch(
      /^tmux split-window -h -l 50% "TMUX= tmux attach-session -t 106-tennis-court-v2:0"$/,
    );
  });
});
