/**
 * buildCommand — channelEnv tests
 *
 * Covers: tilde expansion (#1135) + shell-vs-config precedence (#1148).
 * Both groups exercise the channelEnv prepend path in src/config/command.ts.
 *
 * Split from command-simplified.test.ts (2026-05-07) per modular-tests memory.
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

const { buildCommand } = await import("../src/config/command");

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

describe("buildCommand — channelEnv tilde expansion (#1135)", () => {
  test("leading tilde in env value expands to homedir before single-quoting", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channelEnv: { DISCORD_STATE_DIR: "~/.claude/channels/mybot" },
      channels: ["plugin:discord@claude-plugins-official"],
    });
    const home = require("os").homedir();
    expect(out).toContain(`DISCORD_STATE_DIR='${home}/.claude/channels/mybot'`);
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
