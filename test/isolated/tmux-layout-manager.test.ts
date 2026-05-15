import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const realSdk = await import("../../src/sdk");

let commands: string[] = [];
let paneHeights = "12\n8\n4";
let queryError: Error | null = null;

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("list-panes") && cmd.includes("#{pane_height}")) {
      if (queryError) throw queryError;
      return paneHeights;
    }
    return "";
  },
}));

const {
  canEnableBorderStatus,
  enableBorderStatus,
  MIN_BORDER_STATUS_PANE_HEIGHT,
} = await import("../../src/commands/plugins/tmux/layout-manager");

describe("tmux layout-manager border status guard (#1468)", () => {
  beforeEach(() => {
    commands = [];
    paneHeights = "12\n8\n4";
    queryError = null;
  });

  test("normal panes enable bottom border status", async () => {
    expect(MIN_BORDER_STATUS_PANE_HEIGHT).toBe(4);
    expect(await enableBorderStatus("@win1")).toBe(true);

    expect(commands).toEqual([
      "tmux list-panes -t '@win1' -F '#{pane_height}'",
      "tmux set-option -w -t '@win1' pane-border-status bottom",
    ]);
  });

  test("tiny panes skip the window-wide bottom border status option", async () => {
    paneHeights = "12\n3\n8";

    expect(await enableBorderStatus("@win1")).toBe(false);
    expect(commands).toEqual([
      "tmux list-panes -t '@win1' -F '#{pane_height}'",
    ]);
  });

  test("pane-height query failures fail soft and skip cosmetic border status", async () => {
    queryError = new Error("can't find window");

    expect(await enableBorderStatus("@missing")).toBe(false);
    expect(commands).toEqual([
      "tmux list-panes -t '@missing' -F '#{pane_height}'",
    ]);
  });

  test("empty or unparsable height output is not trusted", async () => {
    paneHeights = "\nnot-a-number\n";

    expect(await canEnableBorderStatus("@win1")).toBe(false);
    expect(commands).toEqual([
      "tmux list-panes -t '@win1' -F '#{pane_height}'",
    ]);
  });
});
