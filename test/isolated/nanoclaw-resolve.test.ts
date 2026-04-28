/**
 * Tests for resolveNanoclawJid from src/bridges/nanoclaw.ts.
 * Uses mock.module to stub loadConfig.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

let nanoclawConfig: any = null;

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "white",
    ghqRoot: "/tmp",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
    nanoclaw: nanoclawConfig,
  }),
}));

// Mock core/paths to avoid mkdirSync at import
mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

const { resolveNanoclawJid } = await import("../../src/bridges/nanoclaw");

describe("resolveNanoclawJid", () => {
  beforeEach(() => {
    nanoclawConfig = null;
  });

  it("returns null when nanoclaw not configured", () => {
    nanoclawConfig = null;
    expect(resolveNanoclawJid("nat")).toBeNull();
  });

  it("returns null when nanoclaw has no URL", () => {
    nanoclawConfig = { channels: { nat: "tg:123" } };
    expect(resolveNanoclawJid("nat")).toBeNull();
  });

  it("passes through direct JID (tg:)", () => {
    nanoclawConfig = { url: "http://localhost:3001", channels: {} };
    const result = resolveNanoclawJid("tg:123456789");
    expect(result).toEqual({ jid: "tg:123456789", url: "http://localhost:3001" });
  });

  it("passes through direct JID (dc:)", () => {
    nanoclawConfig = { url: "http://localhost:3001", channels: {} };
    const result = resolveNanoclawJid("dc:987654321");
    expect(result).toEqual({ jid: "dc:987654321", url: "http://localhost:3001" });
  });

  it("resolves channel alias with prefix", () => {
    nanoclawConfig = { url: "http://localhost:3001", channels: { nat: "tg:111" } };
    const result = resolveNanoclawJid("telegram:nat");
    expect(result).toEqual({ jid: "tg:111", url: "http://localhost:3001" });
  });

  it("resolves bare channel alias", () => {
    nanoclawConfig = { url: "http://localhost:3001", channels: { nat: "tg:111", dev: "dc:222" } };
    expect(resolveNanoclawJid("nat")).toEqual({ jid: "tg:111", url: "http://localhost:3001" });
    expect(resolveNanoclawJid("dev")).toEqual({ jid: "dc:222", url: "http://localhost:3001" });
  });

  it("returns null for unknown alias", () => {
    nanoclawConfig = { url: "http://localhost:3001", channels: { nat: "tg:111" } };
    expect(resolveNanoclawJid("unknown")).toBeNull();
  });

  it("supports all JID prefixes", () => {
    nanoclawConfig = { url: "http://nc:3001", channels: {} };
    for (const prefix of ["tg", "dc", "sl", "wa", "gm", "mx"]) {
      const result = resolveNanoclawJid(`${prefix}:12345`);
      expect(result).not.toBeNull();
      expect(result!.jid).toBe(`${prefix}:12345`);
    }
  });
});
