/**
 * buildCommand — permissionMode tests (#1146)
 *
 * Covers: relay vs skip, channelEnv interaction, no-channels case,
 * --continue plumbing under relay mode.
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

describe("buildCommand — permissionMode (#1146)", () => {
  test("default (unset) preserves #1108 behavior — injects --dangerously-skip-permissions", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channels: ["plugin:discord@claude-plugins-official"],
    });
    expect(out).toContain("--dangerously-skip-permissions");
    expect(out).toContain("--continue");
    expect(out).toContain("--channels plugin:discord@claude-plugins-official");
  });

  test('permissionMode "skip" is identical to default — flag present', () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channels: ["plugin:discord@claude-plugins-official"],
      permissionMode: "skip",
    });
    expect(out).toContain("--dangerously-skip-permissions");
    expect(out).toContain("--continue");
  });

  test('permissionMode "relay" omits --dangerously-skip-permissions but keeps --continue + --channels', () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channels: ["plugin:discord@claude-plugins-official"],
      permissionMode: "relay",
    });
    expect(out).not.toContain("--dangerously-skip-permissions");
    expect(out).toContain("--channels plugin:discord@claude-plugins-official");
    expect(out).toContain("--continue");
  });

  test('permissionMode "relay" with channelEnv — env still prepended, skip flag still omitted', () => {
    fakeConfig.commands = { default: "claude" };
    const home = require("os").homedir();
    const out = buildCommand("bot", {
      channels: ["plugin:discord@claude-plugins-official"],
      channelEnv: { DISCORD_STATE_DIR: "~/.claude/channels/mybot" },
      permissionMode: "relay",
    });
    expect(out).toContain(`DISCORD_STATE_DIR='${home}/.claude/channels/mybot'`);
    expect(out).not.toContain("--dangerously-skip-permissions");
  });

  test("permissionMode is ignored when no channels are configured (no flag injection in either case)", () => {
    fakeConfig.commands = { default: "claude" };
    const skipOut = buildCommand("bot", { permissionMode: "skip" });
    const relayOut = buildCommand("bot", { permissionMode: "relay" });
    expect(skipOut).not.toContain("--dangerously-skip-permissions");
    expect(relayOut).not.toContain("--dangerously-skip-permissions");
  });

  test('permissionMode "relay" preserves --continue plumbing (|| fallback wrap from #1091)', () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("bot", {
      channels: ["plugin:discord@claude-plugins-official"],
      permissionMode: "relay",
    });
    expect(out).toContain("--continue");
    expect(out).not.toContain("--dangerously-skip-permissions");
    expect(out).toContain(" || ");
  });
});
