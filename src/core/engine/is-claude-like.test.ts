import { describe, it, expect } from "bun:test";
import { isClaudeLikeEngine } from "./is-claude-like";
import type { MawConfig } from "../../config/types";

describe("isClaudeLikeEngine", () => {
  it("returns false for empty / undefined engine", () => {
    expect(isClaudeLikeEngine(undefined)).toBe(false);
    expect(isClaudeLikeEngine("")).toBe(false);
    expect(isClaudeLikeEngine("   ")).toBe(false);
  });

  it("matches configured literal claude names", () => {
    const config: Partial<MawConfig> = { commands: { claude: "claude" } };
    expect(isClaudeLikeEngine("claude", config)).toBe(true);
    expect(() => isClaudeLikeEngine("Claude", config)).toThrow(/engine 'Claude' not resolvable/);
  });

  it("treats configured non-claude engines as not claude-like", () => {
    const config: Partial<MawConfig> = {
      engines: {
        codex: { name: "codex", cmd: "codex" },
        opencode: { name: "opencode", cmd: "opencode" },
        aider: { name: "aider", cmd: "aider" },
      },
    };
    expect(isClaudeLikeEngine("codex", config)).toBe(false);
    expect(isClaudeLikeEngine("opencode", config)).toBe(false);
    expect(isClaudeLikeEngine("aider", config)).toBe(false);
  });

  it("resolves a config alias whose command is claude-like", () => {
    const config: Partial<MawConfig> = {
      engines: { fast: { name: "fast", cmd: "claude --model opus" } },
    };
    expect(isClaudeLikeEngine("fast", config)).toBe(true);
  });

  it("resolves a legacy commands alias whose command is claude-like", () => {
    const config: Partial<MawConfig> = {
      commands: { beta: "claudeBeta --foo" },
    };
    expect(isClaudeLikeEngine("beta", config)).toBe(true);
  });

  it("treats a config alias with a non-claude command as not claude-like", () => {
    const config: Partial<MawConfig> = {
      engines: { custom: { name: "custom", cmd: "codex exec" } },
    };
    expect(isClaudeLikeEngine("custom", config)).toBe(false);
  });

  it("matches an engine that declares the system-prompt-file capability", () => {
    const config: Partial<MawConfig> = {
      engines: {
        wrapped: { name: "wrapped", cmd: "my-wrapper", capabilities: ["system-prompt-file"] },
      },
    };
    expect(isClaudeLikeEngine("wrapped", config)).toBe(true);
  });

  it("fails loud for an unconfigured engine name", () => {
    expect(() => isClaudeLikeEngine("mystery")).toThrow(/engine 'mystery' not resolvable/);
  });
});
