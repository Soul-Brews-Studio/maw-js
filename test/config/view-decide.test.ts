/**
 * Tests for src/commands/plugins/view/impl.ts — decideWakePrompt.
 * Pure decision function, no I/O.
 */
import { describe, it, expect } from "bun:test";
import { decideWakePrompt } from "../../src/commands/plugins/view/impl";

describe("decideWakePrompt", () => {
  it("returns skip when --no-wake is set", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true })).toBe("skip");
  });

  it("returns skip when --no-wake even if --wake is set", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true, wake: true })).toBe("skip");
  });

  it("returns force when --wake is set", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true })).toBe("force");
  });

  it("returns skip when not TTY", () => {
    expect(decideWakePrompt({ isTTY: false })).toBe("skip");
  });

  it("returns ask when TTY and no flags", () => {
    expect(decideWakePrompt({ isTTY: true })).toBe("ask");
  });

  it("returns force when TTY with wake flag", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true })).toBe("force");
  });
});
