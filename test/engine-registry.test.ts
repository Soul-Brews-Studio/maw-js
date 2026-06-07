import { describe, expect, test } from "bun:test";

const { DEFAULT_ENGINES, isClaudeLikeCommand, resolveEngine } = await import("../src/config/engine-registry");

describe("generic engine registry (#1960 P1)", () => {
  test("lowers the legacy swarm known agents into dormant EngineDef defaults", () => {
    expect(DEFAULT_ENGINES.claude).toMatchObject({
      name: "claude",
      cmd: "claude",
      label: "Claude Code",
      capabilities: ["channels", "resume", "model", "system-prompt-file"],
      resume: { flag: "--resume", replaces: "--continue", quoteValue: true },
      model: { flag: "--model", default: "sonnet" },
    });
    expect(DEFAULT_ENGINES.codex).toMatchObject({ name: "codex", cmd: "codex", label: "Codex CLI" });
    expect(DEFAULT_ENGINES.opencode).toMatchObject({ name: "opencode", cmd: "opencode", label: "OpenCode" });
    expect(DEFAULT_ENGINES.aider).toMatchObject({ name: "aider", cmd: "aider", label: "Aider" });
  });

  test("resolves config.engines before legacy commands and built-ins", () => {
    const engine = resolveEngine("codex", {
      engines: { codex: { name: "codex", cmd: "codex --config custom", label: "Custom Codex" } },
      commands: { default: "claude", codex: "codex --legacy" },
    } as any);

    expect(engine).toEqual({ name: "codex", cmd: "codex --config custom", label: "Custom Codex" });
  });

  test("synthesizes Claude capabilities for legacy Claude-like command aliases", () => {
    const engine = resolveEngine("claude47", {
      commands: { default: "claude", claude47: "claude47 --continue" },
    } as any);

    expect(engine).toMatchObject({
      name: "claude47",
      cmd: "claude47 --continue",
      capabilities: ["channels", "resume", "model", "system-prompt-file"],
      resume: { flag: "--resume", replaces: "--continue", quoteValue: true },
    });
  });

  test("falls back to built-in engines, then raw command names", () => {
    expect(resolveEngine("aider", { commands: { default: "claude" } } as any)).toMatchObject({
      name: "aider",
      cmd: "aider",
      label: "Aider",
    });
    expect(resolveEngine("gemini", { commands: { default: "claude" } } as any)).toEqual({
      name: "gemini",
      cmd: "gemini",
    });
  });

  test("exports Claude-like command detection for command rendering", () => {
    expect(isClaudeLikeCommand("claude --continue")).toBe(true);
    expect(isClaudeLikeCommand("codex --continue")).toBe(false);
  });
});
