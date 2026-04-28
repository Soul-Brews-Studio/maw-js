/**
 * Tests for lineageOf and timeSince from src/commands/plugins/oracle/impl-helpers.ts.
 * Both are pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { lineageOf, timeSince } from "../../src/commands/plugins/oracle/impl-helpers";
import type { OracleEntry } from "../../src/sdk";

function makeEntry(overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    name: "neo",
    org: "Soul-Brews-Studio",
    repo: "neo-oracle",
    local_path: "/path/to/neo-oracle",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-01-01",
    ...overrides,
  };
}

// ─── lineageOf ──────────────────────────────────────────────────────────────

describe("lineageOf", () => {
  it("returns all-false lineage for bare entry", () => {
    const result = lineageOf(makeEntry(), false, {});
    expect(result.hasFleetConfig).toBe(false);
    expect(result.hasPsi).toBe(false);
    expect(result.isAwake).toBe(false);
    expect(result.inAgents).toBe(false);
    expect(result.federationNode).toBeUndefined();
  });

  it("reflects has_fleet_config from entry", () => {
    const result = lineageOf(makeEntry({ has_fleet_config: true }), false, {});
    expect(result.hasFleetConfig).toBe(true);
  });

  it("reflects has_psi from entry", () => {
    const result = lineageOf(makeEntry({ has_psi: true }), false, {});
    expect(result.hasPsi).toBe(true);
  });

  it("reflects awake status", () => {
    const result = lineageOf(makeEntry(), true, {});
    expect(result.isAwake).toBe(true);
  });

  it("detects agent in agents map", () => {
    const result = lineageOf(makeEntry({ name: "neo" }), false, { neo: "mba" });
    expect(result.inAgents).toBe(true);
    expect(result.federationNode).toBe("mba");
  });

  it("does not detect agent when absent from map", () => {
    const result = lineageOf(makeEntry({ name: "neo" }), false, { pulse: "mba" });
    expect(result.inAgents).toBe(false);
  });

  it("uses federation_node from entry when agents map misses", () => {
    const result = lineageOf(makeEntry({ federation_node: "remote-node" }), false, {});
    expect(result.federationNode).toBe("remote-node");
  });

  it("prefers agents map over entry federation_node", () => {
    const result = lineageOf(
      makeEntry({ name: "neo", federation_node: "old-node" }),
      false,
      { neo: "new-node" },
    );
    expect(result.federationNode).toBe("new-node");
  });

  it("returns undefined federationNode when both sources are null", () => {
    const result = lineageOf(makeEntry({ federation_node: null }), false, {});
    expect(result.federationNode).toBeUndefined();
  });
});

// ─── timeSince ──────────────────────────────────────────────────────────────

describe("timeSince", () => {
  it("returns seconds for recent timestamps", () => {
    const now = new Date();
    now.setSeconds(now.getSeconds() - 30);
    expect(timeSince(now.toISOString())).toBe("30s");
  });

  it("returns minutes for timestamps >60s ago", () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - 5);
    const result = timeSince(now.toISOString());
    expect(result).toMatch(/^\d+m$/);
    expect(parseInt(result)).toBeGreaterThanOrEqual(4);
    expect(parseInt(result)).toBeLessThanOrEqual(5);
  });

  it("returns hours for timestamps >60m ago", () => {
    const now = new Date();
    now.setHours(now.getHours() - 3);
    const result = timeSince(now.toISOString());
    expect(result).toMatch(/^\d+h$/);
    expect(parseInt(result)).toBeGreaterThanOrEqual(2);
    expect(parseInt(result)).toBeLessThanOrEqual(3);
  });

  it("returns days for timestamps >24h ago", () => {
    const now = new Date();
    now.setDate(now.getDate() - 7);
    const result = timeSince(now.toISOString());
    expect(result).toMatch(/^\d+d$/);
    expect(parseInt(result)).toBeGreaterThanOrEqual(6);
    expect(parseInt(result)).toBeLessThanOrEqual(7);
  });

  it("returns 0s for now", () => {
    const result = timeSince(new Date().toISOString());
    expect(result).toBe("0s");
  });
});
