/**
 * buildCommand — post-#541 contract tests
 *
 * Covers: bare cmd, --continue fallback wrap (#1091), pattern match,
 * --resume injection (sessionId), engine selection, no-cd/no-direnv invariant.
 *
 * Split from command-simplified.test.ts (2026-05-07) per modular-tests memory:
 * smaller files contain mock.module pollution per-file.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

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

const RESET = `; printf "\\e[?1049l\\e[0m"; stty sane 2>/dev/null; clear`;
const wrap = (cmd: string) => cmd + RESET;
const wrapFallback = (primary: string, fallback: string) => `{ ${primary} || ${fallback}; }${RESET}`;

describe("buildCommand — post-#541 contract", () => {
  test("auto-injects --continue + fallback when default is bare 'claude' (#1174)", () => {
    // #1174 — `--continue` is the default for ALL claude wakes (engine-aware).
    // Bare "claude" config now produces the wrapped fallback form so a fresh
    // wake resumes the prior conversation in that oracle's cwd, falling back
    // to bare claude when no prior session exists.
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent")).toBe(
      wrapFallback("claude --continue", "claude"),
    );
  });

  test("emits || fallback when default has --continue (#1091 reset suffix)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    expect(buildCommand("any-agent")).toBe(
      wrapFallback("claude --continue --dangerously-skip-permissions", "claude --dangerously-skip-permissions"),
    );
  });

  test("pattern-match wins over default", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo hi" };
    expect(buildCommand("foo-bar")).toBe(wrap("echo hi"));
  });

  test('pattern-match ignores the literal "default" key', () => {
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
    const inner = out.replace(/^\{ /, "").replace(/; \};.*$/, "");
    const [primary, fallback] = inner.split(" || ");
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
    const inner = out.replace(/^\{ /, "").replace(/; \};.*$/, "");
    const [primary, fallback] = inner.split(" || ");
    expect(primary).toContain('--resume "uuid-2"');
    expect(fallback).toContain('--session-id "uuid-2"');
    expect(fallback).not.toContain("--resume");
  });

  test("buildCommandInDir returns session script path (#1188)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const inDir = buildCommandInDir("foo", "/tmp/some where/nested");
    expect(inDir).toStartWith(" bash ");
    expect(inDir).toContain("sessions/foo.sh");
    expect(inDir).not.toContain("cd ");
  });

  test("engine param selects named command from config", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommand("any-agent", "codex")).toBe(wrap("codex --search"));
  });

  test("engine param uses registry when not in config.commands (#1205)", () => {
    fakeConfig.commands = { default: "claude" };
    // #1205 — "gemini" is in ENGINE_DEFS, so the registry builds the command
    // instead of falling through to the default claude command.
    expect(buildCommand("any-agent", "gemini")).toBe("gemini --sandbox");
  });

  test("engine param skips pattern matching", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo pattern", codex: "codex --auto" };
    expect(buildCommand("foo-bar", "codex")).toBe(wrap("codex --auto"));
  });

  test("buildCommandInDir returns session script path with engine (#1188)", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    const result = buildCommandInDir("foo", "/tmp", "codex");
    expect(result).toStartWith(" bash ");
    expect(result).toContain("sessions/foo.sh");
  });

  // #1174 — engine-aware --continue auto-inject for claude wakes.

  test("#1174: non-channel claude wake auto-injects --continue (positive case)", () => {
    fakeConfig.commands = { default: "claude --dangerously-skip-permissions" };
    const out = buildCommand("any-agent");
    expect(out).toContain("--continue");
    expect(out).toContain("||"); // wrapped with fallback
    expect(out).toBe(
      wrapFallback(
        "claude --dangerously-skip-permissions --continue",
        "claude --dangerously-skip-permissions",
      ),
    );
  });

  test("#1174: codex (non-claude) engine does NOT get --continue (engine-aware guard)", () => {
    // codex doesn't recognize --continue, and its silent-ignore behavior
    // would defeat the || fallback. Guard ensures only `claude` cmds get it.
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommand("any-agent", "codex")).toBe(wrap("codex --search"));
    expect(buildCommand("any-agent", "codex")).not.toContain("--continue");
  });

  test("#1174: pattern-matched non-claude command does NOT get --continue", () => {
    // Pattern `foo-*` resolves to `echo hi` — not claude, no --continue.
    fakeConfig.commands = { default: "claude", "foo-*": "echo hi" };
    expect(buildCommand("foo-bar")).toBe(wrap("echo hi"));
    expect(buildCommand("foo-bar")).not.toContain("--continue");
  });

  test("#1174: claude command with channelEnv prefix still gets --continue", () => {
    // Env-var prefix shouldn't fool the engine detector (e.g. via channelEnv).
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("any-agent", { channelEnv: { DISCORD_STATE_DIR: "~/.claude/channels/foo" } });
    expect(out).toContain("DISCORD_STATE_DIR=");
    expect(out).toContain("--continue");
  });

  test("no direnv / CLAUDECODE / cd preamble anywhere in output", () => {
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
        expect(inDir).toStartWith(" bash ");
        expect(inDir).toContain("sessions/");
      }
    }
  });
});
