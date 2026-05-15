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

  // #10 — the guard regex used a loose substring match on `node`, so any
  // command containing "node" passed. tmux #{pane_current_command} is a bare
  // command basename, so `node` is now matched as the WHOLE name only.
  test("rejects non-agent commands that merely contain 'node' (#10)", () => {
    expect(isAgentCommand("nodemon")).toBe(false);
    expect(isAgentCommand("node-red")).toBe(false);
    expect(isAgentCommand("node-gyp")).toBe(false);
    expect(isAgentCommand("nodejs")).toBe(false);
    expect(isAgentCommand("anode")).toBe(false);
  });

  test("still matches bare 'node' regardless of case (#10)", () => {
    expect(isAgentCommand("node")).toBe(true);
    expect(isAgentCommand("Node")).toBe(true);
    expect(isAgentCommand("NODE")).toBe(true);
    expect(isAgentCommand("  node  ")).toBe(true);
  });

  test("claude / codex stay substring-matched (distinctive — no false positives)", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("claude-code")).toBe(true);
    expect(isAgentCommand("codex")).toBe(true);
  });
});
