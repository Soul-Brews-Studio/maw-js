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

// #1091 terminal reset suffix appended by buildCommand to all output
const RESET = `; printf "\\e[?1049l\\e[0m"; stty sane 2>/dev/null; clear`;
const wrap = (cmd: string) => cmd + RESET;
const wrapFallback = (primary: string, fallback: string) => `{ ${primary} || ${fallback}; }${RESET}`;

describe("buildCommand — post-#541 contract", () => {
  test("returns bare default when no --continue (#1091 reset suffix)", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent")).toBe(wrap("claude"));
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
    // Strip outer { ... }; reset wrap to check primary/fallback
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

  test("buildCommandInDir returns buildCommand verbatim (no cd preamble; #1091 reset is part of contract now)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const direct = buildCommand("foo");
    const inDir = buildCommandInDir("foo", "/tmp/some where/nested");
    expect(inDir).toBe(direct);
    expect(inDir).not.toContain("cd ");
    // Note: { is present because of fallback wrap (#1091); only assert no cd.
  });

  test("engine param selects named command from config", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommand("any-agent", "codex")).toBe(wrap("codex --search"));
  });

  test("engine param falls back to default when engine not in config", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent", "gemini")).toBe(wrap("claude"));
  });

  test("engine param skips pattern matching", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo pattern", codex: "codex --auto" };
    expect(buildCommand("foo-bar", "codex")).toBe(wrap("codex --auto"));
  });

  test("buildCommandInDir passes engine through", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommandInDir("foo", "/tmp", "codex")).toBe(wrap("codex --search"));
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

describe("buildCommand — channelEnv tilde expansion (#1135)", () => {
  test("leading tilde in env value expands to homedir before single-quoting", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { DISCORD_STATE_DIR: "~/.claude/channels/mybot" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    const home = require("os").homedir();
    expect(out).toContain(`DISCORD_STATE_DIR='${home}/.claude/channels/mybot'`);
    // Critically: the literal tilde must NOT survive into the quoted value.
    expect(out).not.toContain("'~/.claude/channels/mybot'");
  });

  test("tilde in middle of value is left alone (only leading ~ expands)", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { WEIRD: "/path/with/~/inside" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain("WEIRD='/path/with/~/inside'");
  });

  test("absolute path env value is preserved verbatim (already-fixed configs)", () => {
    fakeConfig.commands = { default: "claude" };
    const home = require("os").homedir();
    const out = buildCommand("bot", {
      channelEnv: { DISCORD_STATE_DIR: `${home}/.claude/channels/mybot` },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain(`DISCORD_STATE_DIR='${home}/.claude/channels/mybot'`);
  });

  test("single quotes inside env value are still escaped after tilde expansion", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { TRICKY: "~/path with 'quotes'" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    const home = require("os").homedir();
    // Single quote inside the value gets the canonical "'\\''" escape sequence.
    expect(out).toContain(`TRICKY='${home}/path with '\\''quotes'\\'''`);
  });

  test("bare tilde (~ alone, no slash) also expands", () => {
    fakeConfig.commands = { default: "claude" };
    const home = require("os").homedir();
    const out = buildCommand("bot", {
      channelEnv: { JUST_TILDE: "~" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain(`JUST_TILDE='${home}'`);
  });
});
