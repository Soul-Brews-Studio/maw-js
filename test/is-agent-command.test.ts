import { describe, test, expect } from "bun:test";
import { isAgentCommand } from "../src/core/transport/ssh";

describe("isAgentCommand", () => {
  test("matches classic agent binary names", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("codex")).toBe(true);
    expect(isAgentCommand("node")).toBe(true);
    expect(isAgentCommand("Claude")).toBe(true);
  });

  test("matches Claude Code 2.1+ versioned binary signature", () => {
    expect(isAgentCommand("2.1.121")).toBe(true);
    expect(isAgentCommand("2.1.116")).toBe(true);
    expect(isAgentCommand("10.0.0")).toBe(true);
  });

  test("rejects shell commands", () => {
    expect(isAgentCommand("zsh")).toBe(false);
    expect(isAgentCommand("bash")).toBe(false);
    expect(isAgentCommand("sh")).toBe(false);
    expect(isAgentCommand("fish")).toBe(false);
  });

  test("handles empty / nullish / whitespace", () => {
    expect(isAgentCommand("")).toBe(false);
    expect(isAgentCommand("   ")).toBe(false);
    expect(isAgentCommand(null)).toBe(false);
    expect(isAgentCommand(undefined)).toBe(false);
  });

  test("rejects partial-version strings", () => {
    expect(isAgentCommand("2.1")).toBe(false);
    expect(isAgentCommand("v2.1.121")).toBe(false);
    expect(isAgentCommand("2.1.121-rc1")).toBe(false);
  });

  test("trims whitespace before matching", () => {
    expect(isAgentCommand("  claude  ")).toBe(true);
    expect(isAgentCommand("\t2.1.121\n")).toBe(true);
  });
});
