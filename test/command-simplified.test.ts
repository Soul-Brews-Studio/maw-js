import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Drives the pure command builder with a per-test mutable fixture so we can
// exercise the post-#541 branches without being affected by Bun's process-global
// module mocks from other test files.
let fakeConfig: any = {
  host: "local",
  port: 3456,
  ghqRoot: "/ghq",
  oracleUrl: "http://localhost",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  agents: {},
  node: "local",
};
let fakeSessionIds: Record<string, string> = {};

const { buildCommandFromConfig, buildCommandInDirFromConfig } = await import("../src/config/command-logic");

function testConfig() {
  return { ...fakeConfig, sessionIds: fakeSessionIds };
}

function buildCommand(agentName: string, engine?: string): string {
  return buildCommandFromConfig(testConfig(), agentName, engine);
}

function buildCommandInDir(agentName: string, cwd: string, engine?: string): string {
  return buildCommandInDirFromConfig(testConfig(), agentName, cwd, engine);
}

// buildCommand strips --dangerously-skip-permissions when process.getuid() === 0
// (root-stripping from #181). Pin the uid to a non-root value regardless of the
// host user so command-string assertions stay stable.
// Fixes #685.
const origGetuid = process.getuid;
beforeEach(() => {
  fakeConfig = {
    host: "local",
    port: 3456,
    ghqRoot: "/ghq",
    oracleUrl: "http://localhost",
    env: {},
    commands: { default: "claude" },
    sessions: {},
    agents: {},
    node: "local",
  };
  fakeSessionIds = {};
  (process as any).getuid = () => 1000;
});
afterEach(() => {
  (process as any).getuid = origGetuid;
});

describe("buildCommand — post-#541 contract", () => {
  test("returns bare default when no --continue", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent")).toBe("claude");
  });

  test("keeps --continue commands clean and leaves fallback to shellenv wrappers", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    expect(buildCommand("any-agent")).toBe(
      "claude --continue --dangerously-skip-permissions",
    );
  });

  test("keeps Claude alias commands clean without duplicating fallback chains", () => {
    fakeConfig.commands = { default: "claude47 --dangerously-skip-permissions --continue" };
    expect(buildCommand("any-agent")).toBe(
      "claude47 --dangerously-skip-permissions --continue",
    );
  });

  test("strips --dangerously-skip-permissions when running as root", () => {
    (process as any).getuid = () => 0;
    fakeConfig.commands = { default: "claude --dangerously-skip-permissions" };

    expect(buildCommand("root-agent")).toBe("claude");
  });

  test("pattern-match wins over default", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo hi" };
    expect(buildCommand("foo-bar")).toBe("echo hi");
  });

  test('pattern-match ignores the literal "default" key', () => {
    // Agent literally named "default" must still hit the default branch, not
    // match the "default" key as a pattern.
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const out = buildCommand("default");
    expect(out).toBe("claude --continue --dangerously-skip-permissions");
    expect(out).not.toContain("||");
  });

  test("sessionId replaces --continue with --resume without adding a shell fallback", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    fakeSessionIds = { foo: "uuid-1" };
    const out = buildCommand("foo");
    expect(out).toContain('--resume "uuid-1"');
    expect(out).not.toContain("--continue");
    expect(out).not.toContain("||");
    expect(out).not.toContain("--session-id");
  });

  test("sessionId appends --resume when cmd has no --continue", () => {
    fakeConfig.commands = { default: "claude" };
    fakeSessionIds = { foo: "uuid-2" };
    const out = buildCommand("foo");
    expect(out).toBe('claude --resume "uuid-2"');
    expect(out).not.toContain("||");
    expect(out).not.toContain("--session-id");
  });

  test("sessionId supports glob fallback when there is no exact agent key", () => {
    fakeConfig.commands = { default: "claude" };
    fakeSessionIds = { "*-oracle": "uuid-glob" };

    const out = buildCommand("mawjs-oracle");

    expect(out).toContain('--resume "uuid-glob"');
    expect(out).not.toContain("||");
    expect(out).not.toContain("--session-id");
  });

  test("buildCommandInDir returns buildCommand verbatim (no cd, no wrapper)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const direct = buildCommand("foo");
    const inDir = buildCommandInDir("foo", "/tmp/some where/nested");
    expect(inDir).toBe(direct);
    expect(inDir).not.toContain("cd ");
    expect(inDir).not.toContain("{ ");
  });

  test("engine param selects named command from config", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommand("any-agent", "codex")).toBe("codex --search");
  });

  test("engine param falls back to default when engine not in config", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent", "gemini")).toBe("claude");
  });

  test("engine param skips pattern matching", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo pattern", codex: "codex --auto" };
    expect(buildCommand("foo-bar", "codex")).toBe("codex --auto");
  });

  test("buildCommandInDir passes engine through", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommandInDir("foo", "/tmp", "codex")).toBe("codex --search");
  });

  test("no direnv / CLAUDECODE / cd preamble anywhere in output", () => {
    // Try a mix of configs and confirm the invariant holds for all.
    const configs: any[] = [
      { default: "claude" },
      { default: "claude --continue --dangerously-skip-permissions" },
      { default: "claude", "foo-*": "echo custom" },
    ];
    for (const commands of configs) {
      fakeConfig.commands = commands;
      for (const name of ["agent", "foo-bar", "default"]) {
        const out = buildCommand(name);
        expect(out).not.toContain("direnv");
        expect(out).not.toContain("CLAUDECODE");
        expect(out.startsWith("cd ")).toBe(false);
        const inDir = buildCommandInDir(name, "/tmp/x");
        expect(inDir).not.toContain("direnv");
        expect(inDir).not.toContain("CLAUDECODE");
        expect(inDir.startsWith("cd ")).toBe(false);
      }
    }
  });
});


describe("buildCommand — Discord channel auto-detect", () => {
  test("buildCommandInDir adds Discord channels for .discord Claude repos without adding fallback", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-discord-"));
    mkdirSync(join(tmp, ".discord"));
    fakeConfig.commands = { default: "claude --dangerously-skip-permissions --continue" };

    const out = buildCommandInDir("xiaoer-oracle", tmp);

    expect(out).toContain("--channels plugin:discord@claude-plugins-official");
    expect(out).not.toContain("||");
  });

  test("buildCommandInDir leaves non-Discord repos and non-Claude engines unchanged", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-normal-"));
    fakeConfig.commands = { default: "claude --continue", codex: "codex --search" };

    expect(buildCommandInDir("plain-oracle", tmp)).not.toContain("--channels");

    mkdirSync(join(tmp, ".discord"));
    expect(buildCommandInDir("plain-oracle", tmp, "codex")).toBe("codex --search");
  });

  test("buildCommandInDir does not duplicate existing channels", () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-channel-"));
    mkdirSync(join(tmp, ".discord"));
    fakeConfig.commands = { default: "claude --channels plugin:custom" };

    expect(buildCommandInDir("bot-oracle", tmp)).toBe("claude --channels plugin:custom");
  });
});
