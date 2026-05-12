import { describe, it, expect, afterEach } from "bun:test";
import {
  ENGINE_DEFS,
  ENGINE_NAMES,
  resolveEngine,
  isEngineInstalled,
  buildEngineCommand,
  resolveDefaultEngine,
} from "./engines";

describe("engines — as-const registry (#1201)", () => {
  it("ENGINE_NAMES matches ENGINE_DEFS keys", () => {
    expect([...ENGINE_NAMES].sort()).toEqual(Object.keys(ENGINE_DEFS).sort());
  });

  it("every engine has required fields", () => {
    for (const name of ENGINE_NAMES) {
      const e = ENGINE_DEFS[name];
      expect(typeof e.binary).toBe("string");
      expect(typeof e.defaultModel).toBe("string");
      expect(typeof e.permissionFlag).toBe("string");
      expect(["file", "stdin"]).toContain(e.promptMode);
    }
  });

  it("resolveEngine accepts valid names", () => {
    expect(resolveEngine("claude")).toBe("claude");
    expect(resolveEngine("codex")).toBe("codex");
    expect(resolveEngine("gemini")).toBe("gemini");
  });

  it("resolveEngine throws on unknown name", () => {
    expect(() => resolveEngine("gpt4all")).toThrow("Unknown engine 'gpt4all'");
  });

  it("resolveEngine error message lists available engines", () => {
    try {
      resolveEngine("nope");
    } catch (e: any) {
      expect(e.message).toContain("claude");
      expect(e.message).toContain("codex");
    }
  });

  it("buildEngineCommand uses default model when none specified", () => {
    const cmd = buildEngineCommand("claude", { promptPath: "/tmp/p.md" });
    expect(cmd).toContain("sonnet");
    expect(cmd).toContain("--prompt-file");
  });

  it("buildEngineCommand accepts custom model override", () => {
    const cmd = buildEngineCommand("claude", { promptPath: "/tmp/p.md", model: "opus" });
    expect(cmd).toContain("opus");
    expect(cmd).not.toContain("sonnet");
  });

  it("buildEngineCommand uses stdin redirect for stdin-mode engines", () => {
    const cmd = buildEngineCommand("codex", { promptPath: "/tmp/p.md" });
    expect(cmd).toContain("< '/tmp/p.md'");
    expect(cmd).not.toContain("--prompt-file");
  });

  it("buildEngineCommand uses --prompt-file for file-mode engines", () => {
    const cmd = buildEngineCommand("aider", { promptPath: "/tmp/p.md" });
    expect(cmd).toContain("--prompt-file '/tmp/p.md'");
  });

  it("buildEngineCommand escapes single quotes in path", () => {
    const cmd = buildEngineCommand("claude", { promptPath: "/tmp/nat's file.md" });
    expect(cmd).toContain("nat'\\''s file.md");
  });

  it("buildEngineCommand includes permission flag", () => {
    const cmd = buildEngineCommand("codex", { promptPath: "/tmp/p.md" });
    expect(cmd).toContain("-c approval_policy=never");
  });

  it("buildEngineCommand omits empty permission flag", () => {
    const cmd = buildEngineCommand("opencode", { promptPath: "/tmp/p.md" });
    expect(cmd).not.toContain("  "); // no double-space from empty flag
    expect(cmd).toStartWith("opencode --model");
  });

  it("isEngineInstalled returns boolean for claude", () => {
    const result = isEngineInstalled("claude");
    expect(typeof result).toBe("boolean");
  });
});

describe("resolveDefaultEngine — override chain (#1205)", () => {
  const savedEnv = process.env.MAW_ENGINE;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MAW_ENGINE;
    else process.env.MAW_ENGINE = savedEnv;
  });

  it("returns claude when no overrides set", () => {
    delete process.env.MAW_ENGINE;
    expect(resolveDefaultEngine()).toBe("claude");
  });

  it("MAW_ENGINE env var wins over everything", () => {
    process.env.MAW_ENGINE = "codex";
    expect(resolveDefaultEngine()).toBe("codex");
  });

  it("ignores invalid MAW_ENGINE values", () => {
    process.env.MAW_ENGINE = "invalid-engine";
    expect(resolveDefaultEngine()).toBe("claude");
  });
});
