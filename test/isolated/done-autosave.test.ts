/**
 * Tests for signalParentInbox from src/commands/plugins/done/done-autosave.ts.
 * Mocks sdk, reunion, soul-sync to test inbox signal logic.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "done-autosave-"));
const inboxDir = join(tmp, ".oracle", "inbox");

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rSdk = await import("../../src/sdk");

mock.module("../../src/sdk", () => ({
  ..._rSdk,
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  hostExec: async () => "",
  tmux: {
    sendText: async () => {},
    ls: async () => [],
    run: async () => "",
    kill: async () => {},
    killWindow: async () => {},
  },
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({
    ghqRoot: join(tmp, "ghq"),
    node: "test",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/commands/plugins/reunion/impl", () => ({
  cmdReunion: async () => {},
}));

mock.module("../../src/commands/plugins/soul-sync/impl", () => ({
  cmdSoulSync: async () => {},
}));

// Override homedir to temp dir for inbox
mock.module("os", () => ({
  ...require("os"),
  homedir: () => tmp,
}));

const { signalParentInbox } = await import(
  "../../src/commands/plugins/done/done-autosave"
);

beforeEach(() => {
  try { rmSync(inboxDir, { recursive: true, force: true }); } catch {}
});

describe("signalParentInbox", () => {
  it("does nothing when session not found", async () => {
    await signalParentInbox("neo-oracle", "nonexistent", []);
    expect(existsSync(inboxDir)).toBe(false);
  });

  it("does nothing when session has no windows", async () => {
    await signalParentInbox("neo-oracle", "proj", [
      { name: "proj", windows: [] },
    ]);
  });

  it("writes signal to parent inbox", async () => {
    await signalParentInbox("child-oracle", "proj", [
      { name: "proj", windows: [
        { index: 0, name: "parent-oracle", active: true },
        { index: 1, name: "child-oracle", active: false },
      ] },
    ]);
    const signalFile = join(inboxDir, "parent-oracle.jsonl");
    expect(existsSync(signalFile)).toBe(true);
    const content = readFileSync(signalFile, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("done");
    expect(parsed.from).toBe("child-oracle");
    expect(parsed.msg).toContain("child-oracle");
  });

  it("uses first window as parent", async () => {
    await signalParentInbox("child", "proj", [
      { name: "proj", windows: [
        { index: 0, name: "leader", active: true },
        { index: 1, name: "child", active: false },
        { index: 2, name: "another", active: false },
      ] },
    ]);
    expect(existsSync(join(inboxDir, "leader.jsonl"))).toBe(true);
  });

  it("signal contains timestamp", async () => {
    const before = new Date().toISOString();
    await signalParentInbox("child", "proj", [
      { name: "proj", windows: [{ index: 0, name: "parent", active: true }] },
    ]);
    const content = readFileSync(join(inboxDir, "parent.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBeDefined();
    expect(parsed.ts >= before).toBe(true);
  });

  it("sanitizes parent name for filename", async () => {
    await signalParentInbox("child", "proj", [
      { name: "proj", windows: [{ index: 0, name: "valid-name_123", active: true }] },
    ]);
    expect(existsSync(join(inboxDir, "valid-name_123.jsonl"))).toBe(true);
  });
});
