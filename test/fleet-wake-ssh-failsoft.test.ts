/**
 * fleet-wake-ssh-failsoft.test.ts — Nat's repro (oracle-world → white DNS)
 *
 * Before this fix, `maw wake all` would print a single session entry, emit the
 * ssh DNS error, and silently stop — the whole loop halted because the first
 * remote-routed tmux call's rejection wasn't caught.
 *
 * The fix adds a pure helper `runWakeLoopFailSoft()` that:
 *   - catches HostExecError with transport === "ssh" per-step,
 *   - emits a compact "⚠ [N/M] <name> — [ssh:<host>] unreachable: …" warning,
 *   - increments a remoteSkipped counter,
 *   - and continues the loop.
 *
 * These tests pin that logic without mocking the sdk/tmux graph — which is
 * deliberately fragile across test files (mock.module is process-global;
 * see #375). A separate integration stack exercises cmdWakeAll end-to-end.
 */
import { describe, expect, test } from "bun:test";

import {
  firstStderrLine,
  isSshTransportError,
  runWakeLoopFailSoft,
  type WakeStep,
} from "../src/commands/shared/fleet-wake-failsoft";
import { HostExecError } from "../src/core/transport/ssh";

// ─── isSshTransportError ────────────────────────────────────────────────────

describe("isSshTransportError", () => {
  test("true for HostExecError with transport=ssh", () => {
    const e = new HostExecError("white", "ssh", new Error("no route"), 255);
    expect(isSshTransportError(e)).toBe(true);
  });

  test("false for HostExecError with transport=local", () => {
    const e = new HostExecError("local", "local", new Error("command not found"), 127);
    expect(isSshTransportError(e)).toBe(false);
  });

  test("false for plain Error (unrelated failure)", () => {
    expect(isSshTransportError(new Error("generic boom"))).toBe(false);
  });

  test("false for non-Error values", () => {
    expect(isSshTransportError("nope")).toBe(false);
    expect(isSshTransportError(undefined)).toBe(false);
    expect(isSshTransportError(null)).toBe(false);
  });
});

// ─── firstStderrLine ────────────────────────────────────────────────────────

describe("firstStderrLine", () => {
  test("HostExecError: returns first line of stderr message", () => {
    const stderr = "ssh: Could not resolve hostname white: Temporary failure in name resolution\nextra line\nsecond";
    const e = new HostExecError("white", "ssh", new Error(stderr), 255);
    expect(firstStderrLine(e)).toBe("ssh: Could not resolve hostname white: Temporary failure in name resolution");
  });

  test("HostExecError with empty stderr falls back to exit code", () => {
    const e = new HostExecError("white", "ssh", new Error(""), 42);
    expect(firstStderrLine(e)).toBe("exit 42");
  });

  test("generic Error: first line only", () => {
    expect(firstStderrLine(new Error("boom\nstacktrace"))).toBe("boom");
  });

  test("non-Error value: stringified first line", () => {
    expect(firstStderrLine("oops\nmore")).toBe("oops");
  });
});

// ─── runWakeLoopFailSoft ────────────────────────────────────────────────────

describe("runWakeLoopFailSoft — fail-soft on ssh transport failure", () => {
  test("Nat's repro: ssh DNS failure in 1st session, loop finishes 2nd", async () => {
    const calls: string[] = [];
    const steps: WakeStep[] = [
      {
        sessName: "100-boonkeeper",
        run: async () => {
          calls.push("100-boonkeeper");
          throw new HostExecError(
            "white",
            "ssh",
            new Error("ssh: Could not resolve hostname white: Temporary failure in name resolution"),
            255,
          );
        },
      },
      {
        sessName: "200-localfriend",
        run: async () => { calls.push("200-localfriend"); },
      },
    ];

    const result = await runWakeLoopFailSoft(steps);

    // Loop did NOT halt — second step ran
    expect(calls).toEqual(["100-boonkeeper", "200-localfriend"]);

    // Counters reflect 1 success + 1 remote-skip
    expect(result.sessCount).toBe(1);
    expect(result.remoteSkipped).toBe(1);

    // Warning format matches the spec in the task brief
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("[1/2]");
    expect(result.warnings[0]).toContain("100-boonkeeper");
    expect(result.warnings[0]).toContain("[ssh:white]");
    expect(result.warnings[0]).toContain("unreachable:");
    expect(result.warnings[0]).toContain("Could not resolve hostname white");
  });

  test("all sessions succeed → no warnings, no remote-skipped", async () => {
    const steps: WakeStep[] = [
      { sessName: "a", run: async () => {} },
      { sessName: "b", run: async () => {} },
    ];
    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(2);
    expect(result.remoteSkipped).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test("all sessions fail via ssh → all skipped, none succeed, loop still completes", async () => {
    const steps: WakeStep[] = ["a", "b", "c"].map(name => ({
      sessName: name,
      run: async () => {
        throw new HostExecError(name, "ssh", new Error("no route to host"), 255);
      },
    }));

    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(0);
    expect(result.remoteSkipped).toBe(3);
    expect(result.warnings).toHaveLength(3);
  });

  test("non-ssh errors propagate (regression guard — don't silently swallow bugs)", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "broken",
        run: async () => { throw new Error("something else entirely"); },
      },
    ];
    await expect(runWakeLoopFailSoft(steps)).rejects.toThrow("something else entirely");
  });

  test("HostExecError with transport=local propagates (not an ssh skip)", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "local-broken",
        run: async () => {
          throw new HostExecError("local", "local", new Error("tmux not installed"), 127);
        },
      },
    ];
    await expect(runWakeLoopFailSoft(steps)).rejects.toThrow();
  });

  test("empty steps list → zero counters, no throw", async () => {
    const result = await runWakeLoopFailSoft([]);
    expect(result.sessCount).toBe(0);
    expect(result.remoteSkipped).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});
