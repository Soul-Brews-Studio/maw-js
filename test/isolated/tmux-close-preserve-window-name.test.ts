import { afterEach, describe, expect, test } from "bun:test";
import { createTmuxHandler } from "../../src/commands/plugins/tmux/index";
import type { InvokeContext } from "../../src/plugin/types";

const OLD_TMUX = process.env.TMUX;
const OLD_TMUX_PANE = process.env.TMUX_PANE;

afterEach(() => {
  if (OLD_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = OLD_TMUX;
  if (OLD_TMUX_PANE === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = OLD_TMUX_PANE;
});

function cli(args: string[]): InvokeContext {
  return { source: "cli", args } as any;
}

function handlerWithHostExec(hostExec: (cmd: string) => Promise<string>) {
  return createTmuxHandler({
    hostExec,
    cmdTmuxPeek: async () => {},
    cmdTmuxLs: async () => {},
    cmdTmuxSend: async () => {},
    cmdTmuxSplit: async () => {},
    cmdTmuxKill: async () => {},
    cmdTmuxLayout: async () => {},
    cmdTmuxPipePane: async () => {},
    cmdTmuxSynchronizePanes: async () => {},
    cmdTmuxAttach: () => {},
    resolveTmuxTarget: (target: string) => ({ resolved: target, source: "test" }),
    cmdSplit: async () => {},
  } as any);
}

describe("maw tmux close window-name preservation (#1974)", () => {
  test("explicit close names the broken-out pane window after its current window", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%1";
    const calls: string[] = [];
    const handler = handlerWithHostExec(async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("display-message")) return "volt-coder-1\n";
      return "";
    });

    const result = await handler(cli(["close", "%2"]));

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "tmux display-message -p -t '%2' '#{window_name}'",
      "tmux break-pane -d -t '%2' -n 'volt-coder-1'",
    ]);
  });

  test("sweep close preserves each sibling pane's window name", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%1";
    const calls: string[] = [];
    const handler = handlerWithHostExec(async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("list-panes")) return "%1\n%2\n%3\n";
      if (cmd.includes("display-message")) return "main-work\n";
      return "";
    });

    const result = await handler(cli(["close"]));

    expect(result.ok).toBe(true);
    expect(calls).toContain("tmux break-pane -d -t '%2' -n 'main-work'");
    expect(calls).toContain("tmux break-pane -d -t '%3' -n 'main-work'");
  });
});
