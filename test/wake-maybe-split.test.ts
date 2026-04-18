/**
 * wake-maybe-split.test.ts — #539 P1+P4 coverage.
 *
 * Covers src/commands/shared/wake-maybe-split.ts:
 *   - maybeSplit: 2 no-op guards (opts.split undefined / false)
 *   - maybeSplit: in-tmux happy path delegates to cmdSplit
 *   - maybeSplit: in-tmux, cmdSplit throws → logs "split failed" line
 *   - maybeSplit: out-of-tmux, tmux server up → logs attach runbook
 *   - maybeSplit: out-of-tmux, no tmux server → logs start runbook
 *   - probeTmuxServer: true when hostExec resolves, false when it rejects
 *
 * Mocked seams: src/sdk (hostExec), src/commands/plugins/split/impl (cmdSplit).
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

// ─── Mutable stubs ───────────────────────────────────────────────────────────

let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let cmdSplitImpl: (target: string) => Promise<void> = async () => {};
let cmdSplitCalls: string[] = [];

// ─── Mocks (must install before importing the module-under-test) ─────────────

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  hostExec: (cmd: string) => hostExecImpl(cmd),
}));

mock.module(join(import.meta.dir, "../src/commands/plugins/split/impl"), () => ({
  cmdSplit: async (target: string) => {
    cmdSplitCalls.push(target);
    return cmdSplitImpl(target);
  },
}));

// ─── Import module-under-test (after mocks installed) ────────────────────────

const { maybeSplit, probeTmuxServer } = await import(
  "../src/commands/shared/wake-maybe-split"
);

// ─── Harness for capturing console.log + managing TMUX env ───────────────────

const origLog = console.log;
let logs: string[] = [];
let savedTmux: string | undefined;

// Strip ANSI color/style escapes so assertions can match literal text without
// needing to know the exact color codes maybeSplit emits.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function captureLogs() {
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(
      stripAnsi(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "))
    );
  };
}

beforeEach(() => {
  savedTmux = process.env.TMUX;
  delete process.env.TMUX;
  cmdSplitCalls = [];
  cmdSplitImpl = async () => {};
  hostExecImpl = async () => "";
  captureLogs();
});

afterEach(() => {
  console.log = origLog;
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

afterAll(() => {
  console.log = origLog;
});

// ─── maybeSplit — no-op guards ───────────────────────────────────────────────

describe("maybeSplit — no-op guards", () => {
  test("opts.split undefined → nothing logged, cmdSplit not called, hostExec not called", async () => {
    let hostExecCalled = false;
    hostExecImpl = async () => {
      hostExecCalled = true;
      return "";
    };
    await maybeSplit("sess:win", {});
    expect(logs.length).toBe(0);
    expect(cmdSplitCalls.length).toBe(0);
    expect(hostExecCalled).toBe(false);
  });

  test("opts.split false → nothing logged, cmdSplit not called, hostExec not called", async () => {
    let hostExecCalled = false;
    hostExecImpl = async () => {
      hostExecCalled = true;
      return "";
    };
    await maybeSplit("sess:win", { split: false });
    expect(logs.length).toBe(0);
    expect(cmdSplitCalls.length).toBe(0);
    expect(hostExecCalled).toBe(false);
  });
});

// ─── maybeSplit — in-tmux (TMUX set) ─────────────────────────────────────────

describe("maybeSplit — in-tmux (TMUX set)", () => {
  test("delegates to cmdSplit with the target", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    await maybeSplit("work:oracle", { split: true });
    expect(cmdSplitCalls).toEqual(["work:oracle"]);
    // Happy path: no warning lines
    const joined = logs.join("\n");
    expect(joined).not.toContain("split failed");
    expect(joined).not.toContain("--split skipped");
  });

  test("cmdSplit throws → logs split-failed warning with the error message", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    cmdSplitImpl = async () => {
      throw new Error("boom");
    };
    await maybeSplit("work:oracle", { split: true });
    expect(cmdSplitCalls).toEqual(["work:oracle"]);
    const joined = logs.join("\n");
    expect(joined).toContain("⚠ split failed:");
    expect(joined).toContain("boom");
  });
});

// ─── maybeSplit — out-of-tmux, server up (attach runbook) ───────────────────

describe("maybeSplit — out-of-tmux, tmux server up", () => {
  test("logs 4-line attach runbook with target + derived session", async () => {
    // TMUX unset (beforeEach) — probeTmuxServer → true (hostExec resolves)
    hostExecImpl = async () => "work\n";
    await maybeSplit("work:oracle", { split: true });

    const joined = logs.join("\n");
    expect(joined).toContain("⚠ --split skipped — shell is not attached to a tmux pane.");
    expect(joined).toContain("state created:");
    expect(joined).toContain("work:oracle");
    expect(joined).toContain("to view:");
    expect(joined).toContain("tmux attach -t work");
    expect(joined).toContain("to silence:");
    expect(joined).toContain("drop --split when running headless");

    // cmdSplit must NOT be called in the out-of-tmux path
    expect(cmdSplitCalls.length).toBe(0);
  });
});

// ─── maybeSplit — out-of-tmux, no server (start runbook) ─────────────────────

describe("maybeSplit — out-of-tmux, no tmux server", () => {
  test("logs 4-line start runbook", async () => {
    hostExecImpl = async () => {
      throw new Error("no server running on /tmp/tmux-1000/default");
    };
    await maybeSplit("work:oracle", { split: true });

    const joined = logs.join("\n");
    expect(joined).toContain("⚠ --split skipped — tmux server not running.");
    expect(joined).toContain("state created:");
    expect(joined).toContain("work:oracle");
    expect(joined).toContain("to start tmux:");
    expect(joined).toContain("tmux new -s work");
    expect(joined).toContain("to silence:");
    expect(joined).toContain("drop --split when running headless");

    expect(cmdSplitCalls.length).toBe(0);
  });
});

// ─── probeTmuxServer ─────────────────────────────────────────────────────────

describe("probeTmuxServer", () => {
  test("returns true when hostExec resolves", async () => {
    hostExecImpl = async () => "some-session\n";
    const result = await probeTmuxServer();
    expect(result).toBe(true);
  });

  test("returns false when hostExec rejects", async () => {
    hostExecImpl = async () => {
      throw new Error("no server running");
    };
    const result = await probeTmuxServer();
    expect(result).toBe(false);
  });
});
