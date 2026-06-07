/**
 * X-high isolated coverage for src/commands/shared/comm-send.ts.
 *
 * This file owns the remaining resolveMyName tmux fallback branches without
 * touching live tmux: child_process.execSync is patched in-process and restored
 * after each test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveMyName } from "../../src/commands/shared/comm-send";

const childProcess = require("child_process") as typeof import("child_process");
const originalExecSync = childProcess.execSync;
const originalAgentName = process.env.CLAUDE_AGENT_NAME;

type ExecSyncCall = { command: string; options: unknown };

function withoutAgentName() {
  delete process.env.CLAUDE_AGENT_NAME;
}

afterEach(() => {
  childProcess.execSync = originalExecSync;
  if (originalAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = originalAgentName;
});

describe("resolveMyName tmux fallback coverage", () => {
  test("uses the tmux session name and strips the numeric maw prefix when no env override exists", () => {
    withoutAgentName();
    const calls: ExecSyncCall[] = [];
    childProcess.execSync = ((command: string, options: unknown) => {
      calls.push({ command, options });
      return "08-mawjs\n";
    }) as typeof childProcess.execSync;

    expect(resolveMyName({ node: "config-node" } as any)).toBe("mawjs");
    expect(calls).toEqual([{ command: "tmux display-message -p '#{session_name}'", options: { encoding: "utf-8" } }]);
  });

  test("falls through to config.node when tmux returns only whitespace", () => {
    withoutAgentName();
    childProcess.execSync = (() => "  \n") as typeof childProcess.execSync;

    expect(resolveMyName({ node: "config-node" } as any)).toBe("config-node");
  });

  test("falls through to cli when tmux lookup throws and config has no node", () => {
    withoutAgentName();
    childProcess.execSync = (() => { throw new Error("tmux unavailable"); }) as typeof childProcess.execSync;

    expect(resolveMyName({} as any)).toBe("cli");
  });
});
