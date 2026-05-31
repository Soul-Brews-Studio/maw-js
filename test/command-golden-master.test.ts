import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { buildCommandFromConfig, buildCommandInDirFromConfig } = await import("../src/config/command-logic");

const baseConfig = {
  host: "local",
  port: 3456,
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: {
    default: "claude",
    claude: "claude",
    codex: "codex",
    opencode: "opencode",
    aider: "aider",
  },
  sessions: {},
  node: "local",
};

const origGetuid = process.getuid;

beforeEach(() => {
  (process as any).getuid = () => 1000;
});

afterEach(() => {
  (process as any).getuid = origGetuid;
});

function build(engine: string, extra: Record<string, unknown> = {}, opts?: any): string {
  return buildCommandFromConfig({ ...baseConfig, ...extra } as any, `${engine}-agent`, opts ?? engine);
}

describe("buildCommandFromConfig golden master (#1960 P0)", () => {
  test("snapshots fresh/resume/channel/model behavior for the four seeded engines", () => {
    const cases = [
      ["claude fresh", build("claude"), "claude"],
      ["claude resume", build("claude", { sessionIds: { "claude-agent": "uuid-claude" } }), 'claude --resume "uuid-claude"'],
      ["claude channels", build("claude", {}, { engine: "claude", channels: ["plugin:discord@claude-plugins-official"] }), "claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"],
      ["claude model", buildCommandFromConfig({ ...baseConfig, commands: { ...baseConfig.commands, claude: "claude --model opus" } } as any, "claude-agent", "claude"), "claude --model opus"],

      ["codex fresh", build("codex"), "codex"],
      ["codex resume legacy-bug", build("codex", { sessionIds: { "codex-agent": "uuid-codex" } }), 'codex --resume "uuid-codex"'],
      ["codex channels ignored", build("codex", {}, { engine: "codex", channels: ["plugin:discord@claude-plugins-official"] }), "codex"],
      ["codex model literal", buildCommandFromConfig({ ...baseConfig, commands: { ...baseConfig.commands, codex: "codex --model gpt-5.5" } } as any, "codex-agent", "codex"), "codex --model gpt-5.5"],

      ["opencode fresh", build("opencode"), "opencode"],
      ["opencode resume legacy-bug", build("opencode", { sessionIds: { "opencode-agent": "uuid-open" } }), 'opencode --resume "uuid-open"'],
      ["opencode channels ignored", build("opencode", {}, { engine: "opencode", channels: ["plugin:discord@claude-plugins-official"] }), "opencode"],
      ["opencode model literal", buildCommandFromConfig({ ...baseConfig, commands: { ...baseConfig.commands, opencode: "opencode --model qwen" } } as any, "opencode-agent", "opencode"), "opencode --model qwen"],

      ["aider fresh", build("aider"), "aider"],
      ["aider resume legacy-bug", build("aider", { sessionIds: { "aider-agent": "uuid-aider" } }), 'aider --resume "uuid-aider"'],
      ["aider channels ignored", build("aider", {}, { engine: "aider", channels: ["plugin:discord@claude-plugins-official"] }), "aider"],
      ["aider model literal", buildCommandFromConfig({ ...baseConfig, commands: { ...baseConfig.commands, aider: "aider --model sonnet" } } as any, "aider-agent", "aider"), "aider --model sonnet"],
    ];

    for (const [name, actual, expected] of cases) {
      expect(actual, name).toBe(expected);
    }
  });

  test("snapshots root uid permission stripping", () => {
    (process as any).getuid = () => 0;

    expect(buildCommandFromConfig({ ...baseConfig, commands: { default: "claude --dangerously-skip-permissions" } } as any, "root-agent")).toBe("claude");
  });

  test("snapshots Discord auto-inject for Claude repos only", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-engine-golden-"));
    mkdirSync(join(tmp, ".discord"));

    expect(buildCommandInDirFromConfig(baseConfig as any, "claude-agent", tmp, "claude")).toBe(
      "claude --channels plugin:discord@claude-plugins-official",
    );
    expect(buildCommandInDirFromConfig(baseConfig as any, "codex-agent", tmp, "codex")).toBe("codex");
  });
});
