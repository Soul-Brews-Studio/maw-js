import { describe, test, expect } from "bun:test";
import { isAgentCommand } from "../src/core/transport/ssh";
import { engineIdlePromptPatterns, isAgentCommandForConfig } from "../src/core/agent-detect";

describe("isAgentCommand", () => {
  test("matches classic agent binary names", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("codex")).toBe(true);
    expect(isAgentCommand("node")).toBe(true);
    expect(isAgentCommand("Claude")).toBe(true);
  });

  test("strips Windows .exe/.cmd/.bat suffix — fleet liveness root cause (eq3)", () => {
    // Claude Code reports `claude.exe` via tmux pane_current_command; without
    // suffix-stripping every live agent reads as dead → preflight "0 alive".
    expect(isAgentCommand("claude.exe")).toBe(true);
    expect(isAgentCommand("Claude.EXE")).toBe(true);
    expect(isAgentCommand("/usr/local/bin/claude.exe")).toBe(true);
    expect(isAgentCommand("claude.cmd")).toBe(true);
    expect(isAgentCommand("claude.bat")).toBe(true);
    expect(isAgentCommand("codex.exe")).toBe(true); // engine-agnostic — not hardcoded
    expect(isAgentCommand("node.exe")).toBe(true);
  });

  test("no false-positive: dead/non-agent panes stay dead even with a suffix", () => {
    expect(isAgentCommand("zsh.exe")).toBe(false);
    expect(isAgentCommand("bash.cmd")).toBe(false);
    expect(isAgentCommand("notepad.exe")).toBe(false);
  });

  test("matches non-claude/codex fleet engines (#1906)", () => {
    expect(isAgentCommand("thclaws")).toBe(true);
    expect(isAgentCommand("thclaude")).toBe(true);
    expect(isAgentCommand("THClaws")).toBe(true);
    expect(isAgentCommand("/usr/local/bin/thclaws")).toBe(true);
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

  test("claude / codex process names remain recognized", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("claude-code")).toBe(true);
    expect(isAgentCommand("codex")).toBe(true);
  });
  test("matches configured engine processNames without hardcoded regex updates", () => {
    const config = {
      commands: {},
      engines: { gemini: { name: "gemini", cmd: "gemini", processNames: ["gemini-cli", "/opt/bin/gemini-agent"] } },
    };

    expect(isAgentCommandForConfig("gemini-cli", config)).toBe(true);
    expect(isAgentCommandForConfig("/opt/bin/gemini-agent", config)).toBe(true);
    expect(isAgentCommandForConfig("gemini-agent-helper", config)).toBe(false);
  });

  test("matches engine idle prompts from configured processNames", () => {
    const config = {
      commands: {},
      engines: { gemini: { name: "gemini", cmd: "gemini", processNames: ["gemini-cli"] } },
    };

    expect(engineIdlePromptPatterns(config).some((pattern) => pattern.test("Ask gemini-cli?"))).toBe(true);
  });

});
