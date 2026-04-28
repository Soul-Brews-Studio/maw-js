/**
 * Tests for lineageOf, timeSince from src/commands/plugins/oracle/impl-helpers.ts.
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { lineageOf, timeSince } from "../../src/commands/plugins/oracle/impl-helpers";
import type { OracleEntry } from "../../src/sdk";

function makeEntry(overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "TestOrg",
    repo: "neo-oracle",
    name: "neo",
    local_path: "/tmp/ghq/TestOrg/neo-oracle",
    has_psi: true,
    has_fleet_config: true,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── lineageOf ──────────────────────────────────────────────────────────────

describe("lineageOf", () => {
  it("sets hasFleetConfig from entry", () => {
    const result = lineageOf(makeEntry({ has_fleet_config: true }), false, {});
    expect(result.hasFleetConfig).toBe(true);
  });

  it("sets hasPsi from entry", () => {
    const result = lineageOf(makeEntry({ has_psi: false }), false, {});
    expect(result.hasPsi).toBe(false);
  });

  it("sets isAwake from parameter", () => {
    expect(lineageOf(makeEntry(), true, {}).isAwake).toBe(true);
    expect(lineageOf(makeEntry(), false, {}).isAwake).toBe(false);
  });

  it("sets inAgents when name is in agents record", () => {
    const result = lineageOf(makeEntry({ name: "neo" }), false, { neo: "node-1" });
    expect(result.inAgents).toBe(true);
  });

  it("sets inAgents false when name missing from agents", () => {
    const result = lineageOf(makeEntry({ name: "neo" }), false, { pulse: "node-2" });
    expect(result.inAgents).toBe(false);
  });

  it("uses agents federation node when available", () => {
    const result = lineageOf(makeEntry({ name: "neo" }), false, { neo: "fed-node" });
    expect(result.federationNode).toBe("fed-node");
  });

  it("falls back to entry federation_node", () => {
    const result = lineageOf(makeEntry({ federation_node: "entry-node" }), false, {});
    expect(result.federationNode).toBe("entry-node");
  });

  it("federationNode is undefined when neither source has it", () => {
    const result = lineageOf(makeEntry({ federation_node: null }), false, {});
    expect(result.federationNode).toBeUndefined();
  });
});

// ─── timeSince ──────────────────────────────────────────────────────────────

describe("timeSince", () => {
  it("returns seconds for recent timestamps", () => {
    const now = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const result = timeSince(now);
    expect(result).toMatch(/^\d+s$/);
  });

  it("returns minutes for medium timestamps", () => {
    const ago = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
    const result = timeSince(ago);
    expect(result).toMatch(/^\d+m$/);
  });

  it("returns hours for older timestamps", () => {
    const ago = new Date(Date.now() - 3 * 3600_000).toISOString(); // 3h ago
    const result = timeSince(ago);
    expect(result).toMatch(/^\d+h$/);
  });

  it("returns days for very old timestamps", () => {
    const ago = new Date(Date.now() - 3 * 86400_000).toISOString(); // 3d ago
    const result = timeSince(ago);
    expect(result).toMatch(/^\d+d$/);
  });

  it("returns 0s for now", () => {
    const result = timeSince(new Date().toISOString());
    expect(result).toBe("0s");
  });
});
