/**
 * buildCommand — channelEnv tests
 *
 * Covers: tilde expansion (#1135) + shell-vs-config precedence (#1148).
 * Both groups exercise the channelEnv prepend path in src/config/command.ts.
 *
 * Split from command-simplified.test.ts (2026-05-07) per modular-tests memory.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

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
const { saveRepoChannels } = await import("../src/commands/shared/channel-loader");

const origGetuid = process.getuid;
// These tests assert that channelEnv values are PREPENDED to the command.
// applyChannelEnv() defers to the shell when a key is already exported
// (#1148 shell-vs-config precedence), so any ambient `DISCORD_STATE_DIR` —
// e.g. the manual `.envrc` workaround discord-oracle uses on oss — would
// suppress the prepend and make these assertions env-dependent (m5 passes,
// oss fails 3). Isolate the real keys these tests use so they're deterministic
// regardless of the runner's environment.
const ISOLATED_ENV_KEYS = ["DISCORD_STATE_DIR", "WEIRD", "TRICKY", "JUST_TILDE"];
let savedEnv: Record<string, string | undefined> = {};
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
  savedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  (process as any).getuid = origGetuid;
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("buildCommand — channelEnv tilde expansion (#1135)", () => {
  test("leading tilde in env value expands to homedir before single-quoting", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { DISCORD_STATE_DIR: "~/.claude/channels/mybot" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    const home = homedir();
    expect(out).toContain(`DISCORD_STATE_DIR='${join(home, ".claude", "channels", "mybot")}'`);
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
    const home = homedir();
    const out = buildCommand("bot", {
      channelEnv: { DISCORD_STATE_DIR: join(home, ".claude", "channels", "mybot") },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain(`DISCORD_STATE_DIR='${join(home, ".claude", "channels", "mybot")}'`);
  });

  test("single quotes inside env value are still escaped after tilde expansion", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { TRICKY: "~/path with 'quotes'" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    const home = homedir();
    const expectedValue = join(home, "path with 'quotes'").replace(/'/g, "'\\''");
    expect(out).toContain(`TRICKY='${expectedValue}'`);
  });

  test("bare tilde (~ alone, no slash) also expands", () => {
    fakeConfig.commands = { default: "claude" };
    const home = homedir();
    const out = buildCommand("bot", {
      channelEnv: { JUST_TILDE: "~" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain(`JUST_TILDE='${home}'`);
  });
});

describe("buildCommand — channelEnv shell-vs-config precedence (#1148)", () => {
  const KEY = "MAWJS_TEST_PRECEDENCE_KEY";
  const KEY1 = "MAWJS_TEST_K1";
  const KEY2 = "MAWJS_TEST_K2";

  afterEach(() => {
    delete process.env[KEY];
    delete process.env[KEY1];
    delete process.env[KEY2];
  });

  test("shell env unset → config value prepended", () => {
    fakeConfig.commands = { default: "claude" };
    delete process.env[KEY];
    const out = buildCommand("bot", { channelEnv: { [KEY]: "from-config" } });
    expect(out).toContain(`${KEY}='from-config'`);
  });

  test("shell env set non-empty → config value NOT prepended (defer to shell)", () => {
    fakeConfig.commands = { default: "claude" };
    process.env[KEY] = "from-shell";
    const out = buildCommand("bot", { channelEnv: { [KEY]: "from-config" } });
    expect(out).not.toContain(`${KEY}='from-config'`);
  });

  test("shell env empty string → config value still prepended (treats empty as unset)", () => {
    fakeConfig.commands = { default: "claude" };
    process.env[KEY] = "";
    const out = buildCommand("bot", { channelEnv: { [KEY]: "from-config" } });
    expect(out).toContain(`${KEY}='from-config'`);
  });

  test("multi-key: shell wins for one, config wins for the other", () => {
    fakeConfig.commands = { default: "claude" };
    process.env[KEY1] = "shell-1";
    delete process.env[KEY2];
    const out = buildCommand("bot", {
      channelEnv: { [KEY1]: "config-1", [KEY2]: "config-2" },
    });
    expect(out).not.toContain(`${KEY1}='config-1'`);
    expect(out).toContain(`${KEY2}='config-2'`);
  });

  test("all keys covered by shell → no envPrefix added at all", () => {
    fakeConfig.commands = { default: "claude" };
    process.env[KEY] = "from-shell";
    const out = buildCommand("bot", { channelEnv: { [KEY]: "from-config" } });
    expect(out).not.toMatch(new RegExp(`\\b${KEY}=`));
  });
});


describe("buildCommandInDir — repo channel config auto-injection (#1877)", () => {
  test("repo .claude/channel.json injects channels, env, and autonomous skip", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-channel-command-repo-"));
    try {
      saveRepoChannels(repo, {
        plugins: [{
          id: "plugin:discord@claude-plugins-official",
          env: { DISCORD_STATE_DIR: "~/.claude/channels/bot" },
        }],
        permissionMode: "skip",
      });

      const out = buildCommandInDir("bot-oracle", repo);

      expect(out).toContain("--channels plugin:discord@claude-plugins-official");
      expect(out).toContain("--dangerously-skip-permissions");
      expect(out).toContain(`DISCORD_STATE_DIR='${join(homedir(), ".claude", "channels", "bot")}'`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("relay permission mode does not add skip flag", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-channel-command-repo-"));
    try {
      saveRepoChannels(repo, {
        plugins: [{ id: "plugin:discord@claude-plugins-official" }],
        permissionMode: "relay",
      });

      const out = buildCommandInDir("bot-oracle", repo);

      expect(out).toContain("--channels plugin:discord@claude-plugins-official");
      expect(out).not.toContain("--dangerously-skip-permissions");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("non-Claude engines ignore channel config", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-channel-command-repo-"));
    try {
      fakeConfig.commands = { default: "claude", codex: "codex --search" };
      saveRepoChannels(repo, {
        plugins: [{ id: "plugin:discord@claude-plugins-official" }],
      });

      expect(buildCommandInDir("bot-oracle", repo, "codex")).toBe("codex --search");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
