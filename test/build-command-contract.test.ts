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

  test("buildCommandInDir returns buildCommand verbatim (no cd preamble; #1091 reset is part of contract now)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    // Pin `fresh` so the buildCommandInDir auto-fresh JSONL probe (#54263ef)
    // doesn't diverge from buildCommand for a cwd that happens to have no
    // continuable session — this test is about the no-`cd`-preamble contract,
    // not the probe (the probe has its own coverage).
    const direct = buildCommand("foo", { fresh: false });
    const inDir = buildCommandInDir("foo", "/tmp/some where/nested", { fresh: false });
    expect(inDir).toBe(direct);
    expect(inDir).not.toContain("cd ");
  });

  test("engine param selects named command from config", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommand("any-agent", "codex")).toBe(wrap("codex --search"));
  });

  test("engine param falls back to default when engine not in config (#1174 fallback for claude)", () => {
    fakeConfig.commands = { default: "claude" };
    // Falls back to default "claude" → #1174 auto-injects --continue.
    expect(buildCommand("any-agent", "gemini")).toBe(
      wrapFallback("claude --continue", "claude"),
    );
  });

  test("engine param skips pattern matching", () => {
    fakeConfig.commands = { default: "claude", "foo-*": "echo pattern", codex: "codex --auto" };
    expect(buildCommand("foo-bar", "codex")).toBe(wrap("codex --auto"));
  });

  test("buildCommandInDir passes engine through", () => {
    fakeConfig.commands = { default: "claude", codex: "codex --search" };
    expect(buildCommandInDir("foo", "/tmp", "codex")).toBe(wrap("codex --search"));
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
        expect(inDir).not.toContain("direnv");
        expect(inDir).not.toContain("CLAUDECODE");
        expect(inDir.startsWith("cd ")).toBe(false);
      }
    }
  });
});

// Prompt baking — regression guard for the directed-inbox `failed_no_prompt`
// silent-fail. The LOC-round-4 refactor dropped `prompt` from buildCommand and
// reintroduced the pre-#541 pattern of appending ` -p '…'` to the *return
// value* of buildCommand — which puts the flag AFTER the `; <reset>` suffix,
// so `-p` lands on the trailing `clear`, not `claude`. The agent wakes idle at
// an empty input box. buildCommand must bake the prompt INSIDE the command.
describe("buildCommand — prompt baking (#wake-no-prompt regression)", () => {
  test("bare claude default: prompt baked into BOTH || fallback branches", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent", { prompt: "hello world" })).toBe(
      wrapFallback("claude --continue -p 'hello world'", "claude -p 'hello world'"),
    );
  });

  test("fresh run: prompt baked before the reset suffix (no fallback)", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("any-agent", { fresh: true, prompt: "do the thing" });
    expect(out).toBe(wrap("claude -p 'do the thing'"));
    // -p must precede the reset suffix — never trail `clear`.
    expect(out).not.toMatch(/clear\s+-p/);
    expect(out.indexOf("-p '")).toBeLessThan(out.indexOf("; printf"));
  });

  test("-p sits inside the brace group, never after the closing `}`", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const out = buildCommand("any-agent", { prompt: "task" });
    expect(out.indexOf("-p 'task'")).toBeLessThan(out.indexOf("; }"));
    expect(out).not.toMatch(/\}\S*\s*-p/);
  });

  test("single quotes in the prompt are shell-escaped", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("any-agent", { fresh: true, prompt: "it's a 'quoted' task" });
    expect(out).toBe(wrap("claude -p 'it'\\''s a '\\''quoted'\\'' task'"));
  });

  test("no prompt → command is byte-identical to the prompt-less form", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommand("any-agent", { prompt: undefined })).toBe(buildCommand("any-agent"));
  });

  test("buildCommandInDir forwards the prompt opt", () => {
    fakeConfig.commands = { default: "claude" };
    expect(buildCommandInDir("foo", "/tmp/x", { fresh: true, prompt: "hi" }))
      .toBe(wrap("claude -p 'hi'"));
  });
});
