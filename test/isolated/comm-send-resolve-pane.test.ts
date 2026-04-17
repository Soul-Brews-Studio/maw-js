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
  findPeerForTarget: async () => null,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false, status: 0, data: null }),
  runHook: async () => {},
  hostExec: async () => "",
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
