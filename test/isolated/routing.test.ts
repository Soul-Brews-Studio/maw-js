/**
 * Tests for resolveTarget from src/core/routing.ts.
 * Uses mock.module to stub resolveFleetSession (reads FLEET_DIR at import time).
 */
import { describe, it, expect, mock } from "bun:test";

// Mock wake-resolve-impl to avoid FLEET_DIR reads
let fleetMap: Record<string, string> = {};
mock.module("../../src/commands/shared/wake-resolve-impl", () => ({
  resolveFleetSession: (oracle: string) => fleetMap[oracle] ?? null,
}));

// Also mock wake (re-exports resolveFleetSession)
mock.module("../../src/commands/shared/wake", () => ({
  resolveFleetSession: (oracle: string) => fleetMap[oracle] ?? null,
}));

// Mock core/paths to avoid mkdirSync at import
mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

// Mock config module
const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "local",
    ghqRoot: "/tmp",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

const { resolveTarget } = await import("../../src/core/routing");
import type { Session, ResolveResult } from "../../src/core/routing";
import type { MawConfig } from "../../src/config";

function makeConfig(overrides: Partial<MawConfig> = {}): MawConfig {
  return {
    node: "white",
    ghqRoot: "/tmp",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
    ...overrides,
  } as MawConfig;
}

function makeSessions(...items: Array<{ name: string; windows: Array<{ index: number; name: string }> }>): Session[] {
  return items.map(s => ({
    name: s.name,
    windows: s.windows.map(w => ({ ...w, active: false })),
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
  // Reset fleet map before each describe block
  fleetMap = {};

  describe("empty query", () => {
    it("returns error for empty string", () => {
      const result = resolveTarget("", makeConfig(), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("empty_query");
      }
    });
  });

  describe("local resolution (Step 1)", () => {
    it("finds window by exact session name", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "mawjs" }] });
      const result = resolveTarget("08-mawjs", makeConfig(), sessions);
      expect(result).toEqual({ type: "local", target: "08-mawjs:0" });
    });

    it("finds window by window name", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "mawjs" }] });
      const result = resolveTarget("mawjs", makeConfig(), sessions);
      expect(result).toEqual({ type: "local", target: "08-mawjs:0" });
    });

    it("finds window by oracle-name (strip NN- prefix)", () => {
      const sessions = makeSessions({ name: "05-pulse", windows: [{ index: 0, name: "pulse" }] });
      const result = resolveTarget("pulse", makeConfig(), sessions);
      expect(result).toEqual({ type: "local", target: "05-pulse:0" });
    });

    it("finds window by substring match", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 2, name: "mawjs-debug" }] });
      const result = resolveTarget("debug", makeConfig(), sessions);
      expect(result).toEqual({ type: "local", target: "08-mawjs:2" });
    });

    it("resolves via fleet config when direct match fails", () => {
      fleetMap["neo"] = "110-neo";
      const sessions = makeSessions({ name: "110-neo", windows: [{ index: 0, name: "neo-oracle" }] });
      const result = resolveTarget("neo", makeConfig(), sessions);
      // findWindow should match "neo" to "neo-oracle" in the 110-neo session
      expect(result).not.toBeNull();
      expect(result!.type).toBe("local");
      fleetMap = {};
    });
  });

  describe("node:prefix syntax (Step 2)", () => {
    it("resolves self-node locally", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "mawjs" }] });
      const result = resolveTarget("white:mawjs", makeConfig({ node: "white" }), sessions);
      expect(result).toEqual({ type: "self-node", target: "08-mawjs:0" });
    });

    it("returns error for self-node agent not running", () => {
      const result = resolveTarget("white:ghost", makeConfig({ node: "white" }), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("self_not_running");
        expect(result!.detail).toContain("ghost");
      }
    });

    it("routes to peer by namedPeers", () => {
      const config = makeConfig({
        node: "white",
        namedPeers: [{ name: "mba", url: "http://mba.local:3456" }] as any,
      });
      const result = resolveTarget("mba:homekeeper", config, []);
      expect(result).toEqual({
        type: "peer",
        peerUrl: "http://mba.local:3456",
        target: "homekeeper",
        node: "mba",
      });
    });

    it("returns error for unknown node", () => {
      const result = resolveTarget("unknown:agent", makeConfig({ node: "white" }), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("unknown_node");
      }
    });

    it("returns error for empty node part", () => {
      const result = resolveTarget(":agent", makeConfig(), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("empty_node_or_agent");
      }
    });

    it("returns error for empty agent part", () => {
      const result = resolveTarget("node:", makeConfig(), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("empty_node_or_agent");
      }
    });
  });

  describe("agents map (Step 3)", () => {
    it("routes via agents map to remote peer", () => {
      const config = makeConfig({
        node: "white",
        agents: { homekeeper: "mba" },
        namedPeers: [{ name: "mba", url: "http://mba.local:3456" }] as any,
      });
      const result = resolveTarget("homekeeper", config, []);
      expect(result).toEqual({
        type: "peer",
        peerUrl: "http://mba.local:3456",
        target: "homekeeper",
        node: "mba",
      });
    });

    it("tries -oracle suffix stripping in agents map", () => {
      const config = makeConfig({
        node: "white",
        agents: { neo: "mba" },
        namedPeers: [{ name: "mba", url: "http://mba.local:3456" }] as any,
      });
      const result = resolveTarget("neo-oracle", config, []);
      expect(result).toEqual({
        type: "peer",
        peerUrl: "http://mba.local:3456",
        target: "neo-oracle",
        node: "mba",
      });
    });

    it("returns error when agent mapped to self-node but not running", () => {
      const config = makeConfig({
        node: "white",
        agents: { ghost: "white" },
      });
      const result = resolveTarget("ghost", config, []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("self_not_running");
      }
    });

    it("returns error when agent mapped to node without peer URL", () => {
      const config = makeConfig({
        node: "white",
        agents: { neo: "mba" },
        namedPeers: [], // no URL for mba
      });
      const result = resolveTarget("neo", config, []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("no_peer_url");
      }
    });
  });

  describe("not found (Step 4)", () => {
    it("returns error when nothing matches", () => {
      const result = resolveTarget("nonexistent", makeConfig(), []);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("not_found");
      }
    });
  });

  describe("legacy peers[] fallback", () => {
    it("finds peer URL from legacy peers array", () => {
      const config = makeConfig({
        node: "white",
        peers: ["http://mba.tailnet:3456"],
      });
      const result = resolveTarget("mba:agent", config, []);
      expect(result).toEqual({
        type: "peer",
        peerUrl: "http://mba.tailnet:3456",
        target: "agent",
        node: "mba",
      });
    });
  });

  describe("edge cases", () => {
    it("does not treat URL-like queries as node:agent", () => {
      // query with "/" should not enter node:prefix branch
      const result = resolveTarget("http://example.com/path", makeConfig(), []);
      expect(result).not.toBeNull();
      // Should fall through to not_found since it has "/" in it
      expect(result!.type).toBe("error");
    });

    it("case insensitive matching", () => {
      const sessions = makeSessions({ name: "08-MawJS", windows: [{ index: 0, name: "MawJS" }] });
      const result = resolveTarget("mawjs", makeConfig(), sessions);
      expect(result!.type).toBe("local");
    });

    it("uses default node 'local' when config.node is undefined", () => {
      const config = makeConfig({ node: undefined as any });
      const result = resolveTarget("local:test", config, []);
      // "local" is selfNode, should try to find "test" locally
      expect(result).not.toBeNull();
      expect(result!.type).toBe("error");
      if (result!.type === "error") {
        expect(result!.reason).toBe("self_not_running");
      }
    });
  });
});
