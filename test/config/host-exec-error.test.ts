/**
 * Tests for src/core/transport/ssh.ts — HostExecError class.
 * Pure Error subclass with target, transport, underlying, exitCode.
 */
import { describe, it, expect } from "bun:test";
import { HostExecError } from "../../src/core/transport/ssh";

describe("HostExecError", () => {
  it("extends Error", () => {
    const err = new HostExecError("target", "ssh", new Error("fail"));
    expect(err).toBeInstanceOf(Error);
  });

  it("has name 'HostExecError'", () => {
    const err = new HostExecError("target", "ssh", new Error("fail"));
    expect(err.name).toBe("HostExecError");
  });

  it("stores target", () => {
    const err = new HostExecError("white", "ssh", new Error("x"));
    expect(err.target).toBe("white");
  });

  it("stores transport 'ssh'", () => {
    const err = new HostExecError("t", "ssh", new Error("x"));
    expect(err.transport).toBe("ssh");
  });

  it("stores transport 'local'", () => {
    const err = new HostExecError("t", "local", new Error("x"));
    expect(err.transport).toBe("local");
  });

  it("stores underlying error", () => {
    const underlying = new Error("original");
    const err = new HostExecError("t", "ssh", underlying);
    expect(err.underlying).toBe(underlying);
  });

  it("stores exitCode", () => {
    const err = new HostExecError("t", "ssh", new Error("x"), 127);
    expect(err.exitCode).toBe(127);
  });

  it("exitCode is undefined when not provided", () => {
    const err = new HostExecError("t", "ssh", new Error("x"));
    expect(err.exitCode).toBeUndefined();
  });

  it("message includes transport and target", () => {
    const err = new HostExecError("white", "ssh", new Error("connection refused"));
    expect(err.message).toContain("[ssh:white]");
    expect(err.message).toContain("connection refused");
  });

  it("has stack trace", () => {
    const err = new HostExecError("t", "ssh", new Error("x"));
    expect(err.stack).toBeDefined();
  });
});
