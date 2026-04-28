/**
 * Tests for src/config/validate-ext.ts — validateConfig (full pipeline).
 *
 * validateConfig delegates to validateBasicFields + validateExtFields,
 * then returns sanitized Partial<MawConfig>. These tests cover the ext
 * fields: triggers, federationToken, allowPeersWithoutToken, trustLoopback,
 * pin, pluginSources, disabledPlugins, node, namedPeers, agents, peers, githubOrg.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { validateConfig } from "../../src/config/validate-ext";

// Suppress console.warn from validateConfig during tests
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => { warnSpy = spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe("validateConfig", () => {
  // ── triggers ─────────────────────────────────────────────────────

  describe("triggers", () => {
    it("keeps valid trigger entries", () => {
      const result = validateConfig({
        triggers: [
          { on: "pr-merge", action: "echo merged", name: "test" },
          { on: "cron", action: "cleanup", schedule: "0 * * * *" },
        ],
      });
      expect(result.triggers).toHaveLength(2);
      expect(result.triggers![0].on).toBe("pr-merge");
    });

    it("filters out invalid triggers (missing on/action)", () => {
      const result = validateConfig({
        triggers: [
          { on: "pr-merge", action: "echo ok" },
          { on: "pr-merge" }, // missing action
          { action: "echo" }, // missing on
          null,
          42,
        ],
      });
      expect(result.triggers).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("rejects non-array triggers", () => {
      const result = validateConfig({ triggers: "not-array" });
      expect(result.triggers).toBeUndefined();
    });

    it("accepts empty triggers array", () => {
      const result = validateConfig({ triggers: [] });
      expect(result.triggers).toEqual([]);
    });
  });

  // ── federationToken ──────────────────────────────────────────────

  describe("federationToken", () => {
    it("accepts token >= 16 chars", () => {
      const token = "a".repeat(16);
      const result = validateConfig({ federationToken: token });
      expect(result.federationToken).toBe(token);
    });

    it("accepts long token", () => {
      const token = "x".repeat(128);
      const result = validateConfig({ federationToken: token });
      expect(result.federationToken).toBe(token);
    });

    it("rejects token < 16 chars", () => {
      const result = validateConfig({ federationToken: "short" });
      expect(result.federationToken).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("rejects non-string", () => {
      const result = validateConfig({ federationToken: 12345 });
      expect(result.federationToken).toBeUndefined();
    });
  });

  // ── allowPeersWithoutToken ───────────────────────────────────────

  describe("allowPeersWithoutToken", () => {
    it("accepts true", () => {
      const result = validateConfig({ allowPeersWithoutToken: true });
      expect(result.allowPeersWithoutToken).toBe(true);
    });

    it("accepts false", () => {
      const result = validateConfig({ allowPeersWithoutToken: false });
      expect(result.allowPeersWithoutToken).toBe(false);
    });

    it("rejects non-boolean", () => {
      const result = validateConfig({ allowPeersWithoutToken: "yes" });
      expect(result.allowPeersWithoutToken).toBeUndefined();
    });
  });

  // ── trustLoopback ────────────────────────────────────────────────

  describe("trustLoopback", () => {
    it("accepts boolean true", () => {
      const result = validateConfig({ trustLoopback: true });
      expect(result.trustLoopback).toBe(true);
    });

    it("accepts boolean false", () => {
      const result = validateConfig({ trustLoopback: false });
      expect(result.trustLoopback).toBe(false);
    });

    it("rejects string", () => {
      const result = validateConfig({ trustLoopback: "false" });
      expect(result.trustLoopback).toBeUndefined();
    });
  });

  // ── pin ──────────────────────────────────────────────────────────

  describe("pin", () => {
    it("accepts string pin", () => {
      const result = validateConfig({ pin: "1234" });
      expect(result.pin).toBe("1234");
    });

    it("rejects non-string", () => {
      const result = validateConfig({ pin: 1234 });
      expect(result.pin).toBeUndefined();
    });
  });

  // ── pluginSources ────────────────────────────────────────────────

  describe("pluginSources", () => {
    it("accepts array of URL strings", () => {
      const urls = ["https://example.com/plugin1", "https://example.com/plugin2"];
      const result = validateConfig({ pluginSources: urls });
      expect(result.pluginSources).toEqual(urls);
    });

    it("filters out non-string entries", () => {
      const result = validateConfig({ pluginSources: ["valid", 123, null, "also-valid"] });
      expect(result.pluginSources).toEqual(["valid", "also-valid"]);
    });

    it("accepts empty array", () => {
      const result = validateConfig({ pluginSources: [] });
      expect(result.pluginSources).toEqual([]);
    });

    it("rejects non-array", () => {
      const result = validateConfig({ pluginSources: "not-array" });
      expect(result.pluginSources).toBeUndefined();
    });
  });

  // ── disabledPlugins ──────────────────────────────────────────────

  describe("disabledPlugins", () => {
    it("accepts array of strings", () => {
      const result = validateConfig({ disabledPlugins: ["foo", "bar"] });
      expect(result.disabledPlugins).toEqual(["foo", "bar"]);
    });

    it("filters non-strings", () => {
      const result = validateConfig({ disabledPlugins: ["ok", 42] });
      expect(result.disabledPlugins).toEqual(["ok"]);
    });

    it("rejects non-array", () => {
      const result = validateConfig({ disabledPlugins: "nope" });
      expect(result.disabledPlugins).toBeUndefined();
    });
  });

  // ── node ─────────────────────────────────────────────────────────

  describe("node", () => {
    it("accepts non-empty string", () => {
      const result = validateConfig({ node: "white" });
      expect(result.node).toBe("white");
    });

    it("trims whitespace", () => {
      const result = validateConfig({ node: "  mba  " });
      expect(result.node).toBe("mba");
    });

    it("rejects empty string", () => {
      const result = validateConfig({ node: "" });
      expect(result.node).toBeUndefined();
    });

    it("rejects whitespace-only", () => {
      const result = validateConfig({ node: "   " });
      expect(result.node).toBeUndefined();
    });

    it("rejects non-string", () => {
      const result = validateConfig({ node: 42 });
      expect(result.node).toBeUndefined();
    });
  });

  // ── namedPeers ───────────────────────────────────────────────────

  describe("namedPeers", () => {
    it("accepts valid {name, url} entries", () => {
      const result = validateConfig({
        namedPeers: [
          { name: "kc", url: "http://kc.local:3456" },
          { name: "mba", url: "https://mba.ts.net:3456" },
        ],
      });
      expect(result.namedPeers).toHaveLength(2);
      expect(result.namedPeers![0].name).toBe("kc");
    });

    it("filters entries with invalid URLs", () => {
      const result = validateConfig({
        namedPeers: [
          { name: "ok", url: "http://valid:3456" },
          { name: "bad", url: "not-a-url" },
        ],
      });
      expect(result.namedPeers).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("filters entries missing name or url", () => {
      const result = validateConfig({
        namedPeers: [
          { name: "ok", url: "http://valid:3456" },
          { name: "no-url" },
          { url: "http://no-name:3456" },
          null,
          42,
        ],
      });
      expect(result.namedPeers).toHaveLength(1);
    });

    it("rejects non-array", () => {
      const result = validateConfig({ namedPeers: "nope" });
      expect(result.namedPeers).toBeUndefined();
    });
  });

  // ── agents ───────────────────────────────────────────────────────

  describe("agents", () => {
    it("accepts valid mapping", () => {
      const mapping = { neo: "white", homekeeper: "mba" };
      const result = validateConfig({ agents: mapping });
      expect(result.agents).toEqual(mapping);
    });

    it("rejects array", () => {
      const result = validateConfig({ agents: ["a", "b"] });
      expect(result.agents).toBeUndefined();
    });

    it("rejects null", () => {
      const result = validateConfig({ agents: null });
      expect(result.agents).toBeUndefined();
    });
  });

  // ── peers ────────────────────────────────────────────────────────

  describe("peers", () => {
    it("accepts array of valid URLs", () => {
      const result = validateConfig({
        peers: ["http://peer1:3456", "https://peer2:3456"],
      });
      expect(result.peers).toHaveLength(2);
    });

    it("filters invalid URLs", () => {
      const result = validateConfig({
        peers: ["http://valid:3456", "not-a-url", "also-bad"],
      });
      expect(result.peers).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("rejects non-array", () => {
      const result = validateConfig({ peers: "http://peer:3456" });
      expect(result.peers).toBeUndefined();
    });
  });

  // ── githubOrg ────────────────────────────────────────────────────

  describe("githubOrg", () => {
    it("passes through string value", () => {
      const result = validateConfig({ githubOrg: "Soul-Brews-Studio" });
      expect(result.githubOrg).toBe("Soul-Brews-Studio");
    });

    it("ignores non-string", () => {
      const result = validateConfig({ githubOrg: 42 });
      expect(result.githubOrg).toBeUndefined();
    });
  });

  // ── integration: basic + ext fields combined ─────────────────────

  it("validates a full realistic config", () => {
    const result = validateConfig({
      host: "prod",
      port: 4000,
      ghqRoot: "/home/user/Code",
      oracleUrl: "http://localhost:47779",
      commands: { default: "claude --dangerously-skip-permissions" },
      sessions: {},
      env: { ANTHROPIC_API_KEY: "sk-123" },
      federationToken: "a-very-secure-token-here",
      node: "white",
      peers: ["http://kc:3456"],
      namedPeers: [{ name: "kc", url: "http://kc.local:3456" }],
      agents: { neo: "white" },
      triggers: [{ on: "cron", action: "echo hello", schedule: "*/5 * * * *" }],
      pluginSources: ["https://example.com/plugin.tar.gz"],
      pin: "1234",
      trustLoopback: false,
    });

    expect(result.host).toBe("prod");
    expect(result.port).toBe(4000);
    expect(result.federationToken).toBe("a-very-secure-token-here");
    expect(result.node).toBe("white");
    expect(result.triggers).toHaveLength(1);
    expect(result.peers).toHaveLength(1);
    expect(result.namedPeers).toHaveLength(1);
    expect(result.trustLoopback).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns but does not throw on invalid fields", () => {
    // Should not throw even with all garbage input
    expect(() => {
      validateConfig({
        host: null,
        port: "abc",
        triggers: 42,
        federationToken: 123,
        peers: "bad",
        namedPeers: "bad",
        node: "",
        pin: 0,
        agents: [],
        pluginSources: "bad",
        disabledPlugins: 42,
      });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});
