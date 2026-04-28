/**
 * Tests for decideWakePrompt from src/commands/plugins/view/impl.ts.
 * Pure decision logic — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { decideWakePrompt } from "../../src/commands/plugins/view/impl";

describe("decideWakePrompt", () => {
  it("returns skip when --no-wake", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true })).toBe("skip");
  });

  it("returns force when --wake", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true })).toBe("force");
  });

  it("returns skip for non-TTY (CI safety)", () => {
    expect(decideWakePrompt({ isTTY: false })).toBe("skip");
  });

  it("returns ask for TTY without flags", () => {
    expect(decideWakePrompt({ isTTY: true })).toBe("ask");
  });

  it("--no-wake takes priority over --wake", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true, noWake: true })).toBe("skip");
  });

  it("--wake takes priority over non-TTY", () => {
    expect(decideWakePrompt({ isTTY: false, wake: true })).toBe("force");
  });

  it("--no-wake takes priority over non-TTY", () => {
    expect(decideWakePrompt({ isTTY: false, noWake: true })).toBe("skip");
  });
});
