/**
 * test/isolated/comm-send-resolve-pane.test.ts
 *
 * Unit tests for resolveOraclePane() after the defensive refactor (H1).
 * Verifies that target strings are passed as discrete args to Tmux.run()
 * rather than interpolated into a shell string — which means injection
 * characters in target values cannot break out of the tmux target context.
 *
 * Isolated because mock.module is process-global and stubs the tmux transport.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// --- Capture real Tmux refs BEFORE any mock.module installs ---
const _rTmux = await import("../../src/core/transport/tmux");

// --- Mutable run stub ---
type RunCall = { subcommand: string; args: (string | number)[] };
let runCalls: RunCall[] = [];
let runReturnValue = "";

// --- Mock tmux module ---
mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    constructor(public host?: string, public socket?: string) {}
    async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
      runCalls.push({ subcommand, args });
      return runReturnValue;
    }
    async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
      return this.run(subcommand, ...args);
    }
  }
  return {
    ..._rTmux,
    Tmux: MockTmux,
    tmux: new MockTmux(),
  };
});

// --- Mock config ---
mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({ node: "test-node" })),
);

// --- Mock sdk (need to stub listSessions etc but not hostExec) ---
mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => [],
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
  isAgentCommand: (cmd: string | null | undefined) => {
    const c = (cmd ?? "").trim();
    return !!c && (/claude|codex|node/i.test(c) || /^\d+\.\d+\.\d+$/.test(c));
  },
  findPeerForTarget: async () => null,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false, status: 0, data: null }),
  runHook: async () => {},
  hostExec: async () => "",
  tmux: { run: async () => "", tryRun: async () => "" },
  FLEET_DIR: "/tmp/maw-test-fleet",
}));

// --- Import the module under test AFTER all mock.module installs ---
const { resolveOraclePane } = await import("../../src/commands/shared/comm-send");

describe("resolveOraclePane — H1 defensive refactor", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
  });

  test("Case 1 — benign target: Tmux.run called with correct args, agent pane selected", async () => {
    // Two panes: index 0 = claude (agent), index 1 = zsh
    runReturnValue = "0 claude\n1 zsh\n";
    const result = await resolveOraclePane("mawjs-session:mawjs-oracle");
    // Should resolve to pane 0 (agent at index 0)
    expect(result).toBe("mawjs-session:mawjs-oracle.0");
    // Should have called Tmux.run with discrete args
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].subcommand).toBe("list-panes");
    expect(runCalls[0].args).toEqual(["-t", "mawjs-session:mawjs-oracle", "-F", "#{pane_index} #{pane_current_command}"]);
  });

  test("Case 2 — injection character in target does NOT reach shell as interpreted text", async () => {
    // Single-pane result so we don't alter the return value
    runReturnValue = "0 claude\n";
    const injectionTarget = "a'; touch /tmp/pwned; tmux #";
    await resolveOraclePane(injectionTarget);
    // Tmux.run must have been called with the literal injection string as a separate arg
    expect(runCalls).toHaveLength(1);
    // The target must appear as a discrete argument element, not inside a shell string
    const targetArgIndex = runCalls[0].args.indexOf(injectionTarget);
    expect(targetArgIndex).toBeGreaterThanOrEqual(0);
    // Verify the injection string is the exact value of args[1] (after "-t")
    expect(runCalls[0].args[0]).toBe("-t");
    expect(runCalls[0].args[1]).toBe(injectionTarget);
  });

  test("Case 3 — pane-specific target passes through untouched (no Tmux.run call)", async () => {
    const result = await resolveOraclePane("session:window.2");
    // Regex short-circuit: already has .N suffix
    expect(result).toBe("session:window.2");
    expect(runCalls).toHaveLength(0);
  });

  test("kobo-83 — a %NNN pane-id passes through untouched, no .index suffix (no Tmux.run call)", async () => {
    // Multi-agent-pane output would otherwise trigger a `.{index}` append; a
    // pane-id must short-circuit BEFORE that so `send-keys -t '%678.1'` (invalid)
    // is never constructed for a kobo-81 team-member pane.
    runReturnValue = "0 zsh\n1 claude\n2 claude\n";
    const result = await resolveOraclePane("%678");
    expect(result).toBe("%678");
    expect(runCalls).toHaveLength(0);
  });

  test("Case 4 — single-pane window: returns target unchanged", async () => {
    runReturnValue = "0 zsh\n";
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
  });

  test("Case 5 — no agent pane found: returns target unchanged", async () => {
    runReturnValue = "0 zsh\n1 bash\n";
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
  });

  test("Case 6 — Tmux.run throws: returns target unchanged (error swallowed)", async () => {
    // Override run to throw
    const _rTmuxAgain = await import("../../src/core/transport/tmux");
    const origRun = (_rTmuxAgain.Tmux.prototype as any).run;
    (_rTmuxAgain.Tmux.prototype as any).run = async () => { throw new Error("tmux not running"); };
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
    (_rTmuxAgain.Tmux.prototype as any).run = origRun;
  });
});

describe("resolveOraclePane — kobo-36 channel→pane routing", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
  });

  // 4-pane warroom: coord (agent) at .1, worker (agent) at .2, main at .0.
  const WARROOM = "0 claude\n1 claude\n2 claude\n3 zsh\n";

  test("channel with a live mapped pane → routes there (overrides default .0)", async () => {
    runReturnValue = WARROOM;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: (oracle, channel) => (oracle === "eq3" && channel === "task-events" ? 1 : null) },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.1"); // coord pane, NOT .0
  });

  test("mapped pane not present in window → falls back to default lowest-agent pane", async () => {
    runReturnValue = WARROOM; // panes 0..3; mapping points at 9 (stale/closed)
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => 9 },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.0"); // stale → default, never a dead index
  });

  test("no mapping for the channel → default behavior unchanged (backward-compat)", async () => {
    runReturnValue = WARROOM;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => null },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.0");
  });

  test("no channel supplied → registry is never consulted", async () => {
    runReturnValue = WARROOM;
    let consulted = false;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => { consulted = true; return 1; } },
      { oracle: "eq3" }, // channel omitted
    );
    expect(consulted).toBe(false);
    expect(result).toBe("eq3:eq3-oracle.0");
  });

  test("explicit .N suffix still wins over any channel mapping", async () => {
    const result = await resolveOraclePane(
      "eq3:eq3-oracle.2",
      { getPaneRouteFn: () => 1 },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.2");
    expect(runCalls).toHaveLength(0); // short-circuits before list-panes
  });
});
