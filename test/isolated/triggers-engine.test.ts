/**
 * Tests for getTriggerHistory, idleTimers, agentPrevState
 * from src/core/runtime/triggers-engine.ts.
 * Uses mock.module to stub config and audit.
 */
import { describe, it, expect, mock } from "bun:test";

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "test",
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

mock.module("../../src/core/fleet/audit", () => ({
  logAudit: () => {},
  logAnomaly: () => {},
  readAudit: () => [],
}));

const {
  getTriggers,
  getTriggerHistory,
  idleTimers,
  agentPrevState,
} = await import("../../src/core/runtime/triggers-engine");

describe("getTriggers", () => {
  it("returns empty array when no triggers configured", () => {
    expect(getTriggers()).toEqual([]);
  });
});

describe("getTriggerHistory", () => {
  it("returns empty array initially", () => {
    expect(getTriggerHistory()).toEqual([]);
  });
});

describe("idleTimers", () => {
  it("is a Map", () => {
    expect(idleTimers instanceof Map).toBe(true);
  });

  it("starts empty", () => {
    expect(idleTimers.size).toBe(0);
  });

  it("can set and get values", () => {
    idleTimers.set("pulse", Date.now());
    expect(idleTimers.has("pulse")).toBe(true);
    idleTimers.delete("pulse");
  });
});

describe("agentPrevState", () => {
  it("is a Map", () => {
    expect(agentPrevState instanceof Map).toBe(true);
  });

  it("starts empty", () => {
    expect(agentPrevState.size).toBe(0);
  });

  it("accepts busy/idle values", () => {
    agentPrevState.set("neo", "busy");
    expect(agentPrevState.get("neo")).toBe("busy");
    agentPrevState.set("neo", "idle");
    expect(agentPrevState.get("neo")).toBe("idle");
    agentPrevState.delete("neo");
  });
});
