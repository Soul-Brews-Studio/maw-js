import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Drives loadConfig() via a per-test mutable fixture so we can exercise the
// post-#541 buildCommand branches (bare cmd, --continue fallback, pattern
// match, --resume injection, no-cd/no-direnv invariant).
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

mock.module("../src/config/load", () => ({
  loadConfig: () => ({ ...fakeConfig, sessionIds: fakeSessionIds }),
  resetConfig: () => {},
  saveConfig: () => fakeConfig,
  configForDisplay: () => ({ ...fakeConfig, envMasked: {} }),
  cfgInterval: () => 1000,
  cfgTimeout: () => 1000,
  cfgLimit: () => 100,
  cfg: (k: string) => (fakeConfig as any)[k],
}));

const { buildCommand, buildCommandInDir } = await import("../src/config/command");

// buildCommand strips --dangerously-skip-permissions when process.getuid() === 0
// (root-stripping from #181). Tests below assert the flag is preserved in the
// fallback, so pin the uid to a non-root value regardless of the host user.
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

  test("emits || fallback when default has --continue", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    expect(buildCommand("any-agent")).toBe(
      "claude --continue --dangerously-skip-permissions || claude --dangerously-skip-permissions",
    );
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
    expect(out).toContain("claude --continue --dangerously-skip-permissions");
    expect(out).toContain("||");
    expect(out).toContain("claude --dangerously-skip-permissions");
  });

  test("sessionId replaces --continue with --resume and fallback carries --session-id", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    fakeSessionIds = { foo: "uuid-1" };
    const out = buildCommand("foo");
    const [primary, fallback] = out.split(" || ");
    expect(primary).toContain('--resume "uuid-1"');
    expect(primary).not.toContain("--continue");
    expect(fallback).toContain('--session-id "uuid-1"');
    expect(fallback).not.toContain("--continue");
    expect(fallback).not.toContain("--resume");
  });

  test("sessionId appends --resume when cmd has no --continue", () => {
    fakeConfig.commands = { default: "claude" };
    fakeSessionIds = { foo: "uuid-2" };
    const out = buildCommand("foo");
    const [primary, fallback] = out.split(" || ");
    expect(primary).toContain('--resume "uuid-2"');
    expect(fallback).toContain('--session-id "uuid-2"');
    expect(fallback).not.toContain("--resume");
  });

  test("buildCommandInDir returns buildCommand verbatim (no cd, no wrapper)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const direct = buildCommand("foo");
    const inDir = buildCommandInDir("foo", "/tmp/some where/nested");
    expect(inDir).toBe(direct);
    expect(inDir).not.toContain("cd ");
    expect(inDir).not.toContain("{ ");
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
