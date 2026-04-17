import { describe, test, expect } from "bun:test";
import { HostExecError } from "../../src/core/transport/ssh";

describe("HostExecError", () => {
  test("carries target + transport + underlying as structured fields", () => {
    const underlying = new Error("not in a mode");
    const err = new HostExecError("white", "ssh", underlying, 1);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HostExecError);
    expect(err.target).toBe("white");
    expect(err.transport).toBe("ssh");
    expect(err.underlying).toBe(underlying);
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe("HostExecError");
  });

  test("message is prefixed with [transport:target] so log-err.message shows context", () => {
    const err = new HostExecError("white", "ssh", new Error("not in a mode"));
    expect(err.message).toBe("[ssh:white] not in a mode");
  });

  test("local transport renders as [local:...]", () => {
    const err = new HostExecError("local", "local", new Error("boom"));
    expect(err.message).toBe("[local:local] boom");
    expect(err.transport).toBe("local");
  });

  test("caller can layer their own context on top (e.g. 'from: getPaneCommands')", () => {
    // Simulating how a caller like getPaneCommands would re-wrap with origin info.
    const raw = new HostExecError("white", "ssh", new Error("not in a mode"));
    const wrapped = new Error(`${raw.message} (from: getPaneCommands)`);
    expect(wrapped.message).toBe("[ssh:white] not in a mode (from: getPaneCommands)");
  });

  test("SSH-unreachable peer surfaces node name, not bare tmux error", () => {
    // Regression: #415 — before the wrap, this was just "not in a mode"
    // with no way to tell which peer produced it.
    const err = new HostExecError(
      "white",
      "ssh",
      new Error("not in a mode"),
    );
    expect(err.message).toContain("white");
    expect(err.message).toContain("ssh");
    expect(err.target).toBe("white");
  });

  test("preserves empty-stderr fallback message from hostExec", () => {
    // hostExec uses `exit ${code}` when stderr is empty; that still flows
    // through as the underlying.
    const err = new HostExecError("local", "local", new Error("exit 1"), 1);
    expect(err.message).toBe("[local:local] exit 1");
    expect(err.exitCode).toBe(1);
  });
});

describe("hostExec throw integration", () => {
  test("failing bash -c throws HostExecError with local transport + host", async () => {
    // MAW_HOST is read at module-load time; we exercise hostExec against
    // a guaranteed-fail shell command and inspect the error shape.
    const { hostExec } = await import("../../src/core/transport/ssh");
    try {
      await hostExec("exit 7", "local");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HostExecError);
      const err = e as HostExecError;
      expect(err.target).toBe("local");
      expect(err.transport).toBe("local");
      expect(err.exitCode).toBe(7);
      expect(err.message).toMatch(/^\[local:local\] /);
    }
  });

  test("failing bash -c propagates stderr into underlying.message", async () => {
    const { hostExec } = await import("../../src/core/transport/ssh");
    try {
      await hostExec("echo oh-no >&2; exit 1", "local");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HostExecError);
      const err = e as HostExecError;
      expect(err.underlying.message).toBe("oh-no");
      expect(err.message).toBe("[local:local] oh-no");
    }
  });
});
