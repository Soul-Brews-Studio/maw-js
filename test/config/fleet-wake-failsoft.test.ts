/**
 * Tests for firstStderrLine, isSshTransportError, runWakeLoopFailSoft
 * from src/commands/shared/fleet-wake-failsoft.ts.
 * Uses HostExecError directly — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { HostExecError } from "../../src/core/transport/ssh";
import {
  firstStderrLine,
  isSshTransportError,
  runWakeLoopFailSoft,
} from "../../src/commands/shared/fleet-wake-failsoft";
import type { WakeStep } from "../../src/commands/shared/fleet-wake-failsoft";

describe("firstStderrLine", () => {
  it("extracts first line from HostExecError", () => {
    const underlying = new Error("Connection refused\nsecond line");
    const err = new HostExecError("host1", "ssh", underlying, 255);
    expect(firstStderrLine(err)).toBe("Connection refused");
  });

  it("returns exit code when underlying message is empty", () => {
    const underlying = new Error("");
    const err = new HostExecError("host1", "ssh", underlying, 1);
    expect(firstStderrLine(err)).toBe("exit 1");
  });

  it("returns exit ? when no exit code and empty message", () => {
    const underlying = new Error("");
    const err = new HostExecError("host1", "ssh", underlying);
    expect(firstStderrLine(err)).toBe("exit ?");
  });

  it("extracts first line from regular Error", () => {
    const err = new Error("first\nsecond\nthird");
    expect(firstStderrLine(err)).toBe("first");
  });

  it("handles non-Error values", () => {
    expect(firstStderrLine("string error")).toBe("string error");
    expect(firstStderrLine(42)).toBe("42");
  });
});

describe("isSshTransportError", () => {
  it("returns true for ssh HostExecError", () => {
    const err = new HostExecError("host1", "ssh", new Error("fail"));
    expect(isSshTransportError(err)).toBe(true);
  });

  it("returns false for local HostExecError", () => {
    const err = new HostExecError("localhost", "local", new Error("fail"));
    expect(isSshTransportError(err)).toBe(false);
  });

  it("returns false for regular Error", () => {
    expect(isSshTransportError(new Error("nope"))).toBe(false);
  });

  it("returns false for non-Error", () => {
    expect(isSshTransportError("string")).toBe(false);
    expect(isSshTransportError(null)).toBe(false);
  });
});

describe("runWakeLoopFailSoft", () => {
  it("runs all steps successfully", async () => {
    const steps: WakeStep[] = [
      { sessName: "a", run: async () => {} },
      { sessName: "b", run: async () => {} },
    ];
    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(2);
    expect(result.remoteSkipped).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns zero counts for empty steps", async () => {
    const result = await runWakeLoopFailSoft([]);
    expect(result.sessCount).toBe(0);
    expect(result.remoteSkipped).toBe(0);
  });

  it("captures ssh errors as warnings and continues", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "remote-sess",
        run: async () => {
          throw new HostExecError("host1", "ssh", new Error("Connection refused"), 255);
        },
      },
      { sessName: "local-sess", run: async () => {} },
    ];
    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(1);
    expect(result.remoteSkipped).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("remote-sess");
    expect(result.warnings[0]).toContain("ssh:host1");
    expect(result.warnings[0]).toContain("unreachable");
  });

  it("propagates non-ssh errors", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "broken",
        run: async () => { throw new Error("unexpected bug"); },
      },
    ];
    expect(runWakeLoopFailSoft(steps)).rejects.toThrow("unexpected bug");
  });

  it("propagates local HostExecError", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "local-broken",
        run: async () => {
          throw new HostExecError("localhost", "local", new Error("bash failed"), 1);
        },
      },
    ];
    expect(runWakeLoopFailSoft(steps)).rejects.toThrow();
  });

  it("includes progress counter in warnings", async () => {
    const steps: WakeStep[] = [
      { sessName: "ok1", run: async () => {} },
      {
        sessName: "fail",
        run: async () => {
          throw new HostExecError("h", "ssh", new Error("timeout"), 255);
        },
      },
      { sessName: "ok2", run: async () => {} },
    ];
    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(2);
    expect(result.remoteSkipped).toBe(1);
    expect(result.warnings[0]).toContain("[2/3]");
  });

  it("skips multiple ssh failures", async () => {
    const steps: WakeStep[] = [
      {
        sessName: "s1",
        run: async () => {
          throw new HostExecError("h1", "ssh", new Error("DNS"), 1);
        },
      },
      {
        sessName: "s2",
        run: async () => {
          throw new HostExecError("h2", "ssh", new Error("refused"), 255);
        },
      },
      { sessName: "s3", run: async () => {} },
    ];
    const result = await runWakeLoopFailSoft(steps);
    expect(result.sessCount).toBe(1);
    expect(result.remoteSkipped).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });
});
