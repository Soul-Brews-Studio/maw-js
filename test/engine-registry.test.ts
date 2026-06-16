import { describe, expect, test } from "bun:test";

const { ENGINE_SEED, defaultEngineNameForConfig, engineNamesForConfig, enginePatternKeysForConfig, isClaudeLikeCommand, isClaudeLikeEngine, resolveEngine } = await import("../src/config/engine-registry");
const { validateBasicFields } = await import("../src/config/validate");

describe("generic engine registry (#1960 P1)", () => {
  test("exposes seed-only engine definitions for init/bootstrap", () => {
    expect(ENGINE_SEED.claude).toMatchObject({
      name: "claude",
      cmd: "claude",
      label: "Claude Code",
      capabilities: ["channels", "resume", "model", "system-prompt-file"],
      resume: { flag: "--resume", replaces: "--continue", quoteValue: true },
      model: { flag: "--model", default: "sonnet" },
    });
    expect(ENGINE_SEED.codex).toMatchObject({ name: "codex", cmd: "codex", label: "Codex CLI" });
    expect(ENGINE_SEED.opencode).toMatchObject({ name: "opencode", cmd: "opencode", label: "OpenCode" });
    expect(ENGINE_SEED.aider).toMatchObject({ name: "aider", cmd: "aider", label: "Aider" });
  });

  test("resolves config.engines before legacy commands", () => {
    const engine = resolveEngine("codex", {
      engines: { codex: { name: "codex", cmd: "codex --config custom", label: "Custom Codex" } },
      commands: { default: "claude", codex: "codex --legacy" },
    } as any);

    expect(engine).toEqual({ name: "codex", cmd: "codex --config custom", label: "Custom Codex" });
  });

  test("keeps default-less legacy commands through validation and resolves explicit engine aliases", () => {
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];
    validateBasicFields({
      commands: { claude48: "ANTHROPIC_MODEL=claude-opus-4-8 command claude" },
      defaultEngine: "claude48",
    }, result, (field: string, msg: string) => warnings.push(`${field}: ${msg}`));

    expect(warnings).toEqual([]);
    expect(result.commands).toEqual({ claude48: "ANTHROPIC_MODEL=claude-opus-4-8 command claude" });
    expect(resolveEngine("claude48", result as any)).toMatchObject({
      name: "claude48",
      cmd: "ANTHROPIC_MODEL=claude-opus-4-8 command claude",
      capabilities: ["channels", "resume", "model", "system-prompt-file"],
    });
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

  test("fails loud instead of resolving unconfigured seed or raw engine names", () => {
    expect(() => resolveEngine("aider", { commands: { default: "claude" } } as any)).toThrow(/engine 'aider' not resolvable/);
    expect(() => resolveEngine("gemini", { commands: { default: "claude" } } as any)).toThrow(/engine 'gemini' not resolvable/);
  });



  test("lists typed engines before legacy shims and keeps configured pattern keys separate from defaults", () => {
    const config = {
      engines: { codex: { name: "codex", cmd: "codex --typed" }, "foo-*": { name: "foo-*", cmd: "foo-typed" } },
      commands: { default: "claude", codex: "codex --legacy", "bar-*": "bar-legacy" },
    } as any;

    expect(engineNamesForConfig(config)).toEqual(["codex", "foo-*", "default", "bar-*"]);
    expect(enginePatternKeysForConfig(config)).toEqual(["codex", "foo-*", "default", "bar-*"]);
  });

  test("chooses config default keys and gates Claude-like behavior by engine capability", () => {
    expect(defaultEngineNameForConfig({ engines: { default: { name: "default", cmd: "codex --typed" } } } as any)).toBe("default");
    expect(defaultEngineNameForConfig({ commands: { default: "claude --legacy" } } as any)).toBe("default");
    expect(defaultEngineNameForConfig({ defaultEngine: "codex" } as any)).toBe("codex");
    expect(() => defaultEngineNameForConfig({} as any)).toThrow(/no default engine configured/);

    expect(() => isClaudeLikeEngine("claude", {} as any)).toThrow(/engine 'claude' not resolvable/);
    expect(isClaudeLikeEngine("claude", { engines: { claude: ENGINE_SEED.claude } } as any)).toBe(true);
    expect(isClaudeLikeEngine("plain-claude", { engines: { "plain-claude": { name: "plain-claude", cmd: "claude" } } } as any)).toBe(false);
    expect(isClaudeLikeEngine("cap-claude", { engines: { "cap-claude": { name: "cap-claude", cmd: "codex", capabilities: ["system-prompt-file"] } } } as any)).toBe(true);
  });

  test("exports Claude-like command detection for command rendering", () => {
    expect(isClaudeLikeCommand("claude --continue")).toBe(true);
    expect(isClaudeLikeCommand("ANTHROPIC_MODEL=claude-opus-4-8 command claude --continue")).toBe(true);
    expect(resolveEngine("claude48", { commands: { claude48: "ANTHROPIC_MODEL=claude-opus-4-8 command claude --continue" } } as any).processNames).toEqual(["claude"]);
    expect(resolveEngine("codex", { commands: { codex: "OMX_AUTO_UPDATE=0 codex --search" } } as any).processNames).toEqual(["codex"]);
    expect(isClaudeLikeCommand("codex --continue")).toBe(false);
  });
});
