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
const originalTmux = process.env.TMUX;

type ExecSyncCall = { command: string; options: unknown };

function withoutAgentName() {
  delete process.env.CLAUDE_AGENT_NAME;
}

function insideTmux() {
  process.env.TMUX = "/tmp/tmux-test,1,0";
}

const originalCwd = process.cwd;

afterEach(() => {
  childProcess.execSync = originalExecSync;
  process.cwd = originalCwd;
  if (originalAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = originalAgentName;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

describe("resolveMyName tmux fallback coverage", () => {
  test("uses the tmux session name and strips the numeric maw prefix when no env override exists", () => {
    withoutAgentName();
    insideTmux();
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
    insideTmux();
    childProcess.execSync = (() => "  \n") as typeof childProcess.execSync;

    expect(resolveMyName({ node: "config-node" } as any)).toBe("config-node");
  });

  test("does not query tmux outside a tmux pane", () => {
    withoutAgentName();
    delete process.env.TMUX;
    const calls: ExecSyncCall[] = [];
    childProcess.execSync = ((command: string, options: unknown) => {
      calls.push({ command, options });
      return "05-nari\n";
    }) as typeof childProcess.execSync;

    expect(resolveMyName({ node: "actual-node" } as any)).toBe("actual-node");
    expect(calls).toEqual([]);
  });

  test("falls through to cli when tmux lookup throws and config has no node", () => {
    withoutAgentName();
    insideTmux();
    childProcess.execSync = (() => { throw new Error("tmux unavailable"); }) as typeof childProcess.execSync;

    expect(resolveMyName({} as any)).toBe("cli");
  });
});

describe("resolveMyName cwd fallback (pulse #159 — tmux client-focus mis-signature fix)", () => {
  test("a confirmed <name>-oracle cwd wins even when tmux would report a different session", () => {
    withoutAgentName();
    insideTmux();
    process.cwd = () => "/Users/phathara/ghq/github.com/phatharaxa-svg/spark-oracle";
    const calls: ExecSyncCall[] = [];
    childProcess.execSync = ((command: string, options: unknown) => {
      calls.push({ command, options });
      return "20-praew\n"; // tmux client focused on a DIFFERENT oracle's session — must not win
    }) as typeof childProcess.execSync;

    expect(resolveMyName({ node: "ignored" } as any)).toBe("spark");
    expect(calls).toEqual([]); // cwd match must short-circuit before tmux is ever queried
  });

  test("a headless/background-job session (no TMUX env at all) still resolves correctly from cwd", () => {
    withoutAgentName();
    delete process.env.TMUX;
    process.cwd = () => "/Users/phathara/ghq/github.com/phatharaxa-svg/intel-nat-oracle";

    expect(resolveMyName({ node: "ignored" } as any)).toBe("intel-nat");
  });

  test("cwd NOT inside any *-oracle repo falls through to tmux, not a false match", () => {
    withoutAgentName();
    insideTmux();
    process.cwd = () => "/Users/phathara/ghq/github.com/Soul-Brews-Studio/maw-js";
    childProcess.execSync = (() => "08-mawjs\n") as typeof childProcess.execSync;

    // must NOT resolve to "maw-js" (the permissive deriveOracleFromCwd fallback would
    // wrongly do this — regression test for that exact bug, caught before merge)
    expect(resolveMyName({ node: "config-node" } as any)).toBe("mawjs");
  });
});
