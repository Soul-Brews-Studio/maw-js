/**
 * Tests for src/commands/plugins/oracle/impl-helpers.ts — lineageOf, timeSince.
 * Pure functions.
 */
import { describe, it, expect } from "bun:test";
import { lineageOf, timeSince } from "../../src/commands/plugins/oracle/impl-helpers";
import type { OracleEntry } from "../../src/core/fleet/registry-oracle-types";

function makeEntry(overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "test-org",
    repo: "test-oracle",
    name: "test",
    local_path: "/repos/test-oracle",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("lineageOf", () => {
  it("returns fleet config status from entry", () => {
    const result = lineageOf(makeEntry({ has_fleet_config: true }), false, {});
    expect(result.hasFleetConfig).toBe(true);
  });

  it("returns psi status from entry", () => {
    const result = lineageOf(makeEntry({ has_psi: true }), false, {});
    expect(result.hasPsi).toBe(true);
  });

  it("returns awake status from parameter", () => {
    const result = lineageOf(makeEntry(), true, {});
    expect(result.isAwake).toBe(true);
  });

  it("detects entry in agents config", () => {
    const result = lineageOf(makeEntry({ name: "spark" }), false, { spark: "mba" });
    expect(result.inAgents).toBe(true);
  });

  it("detects entry NOT in agents config", () => {
    const result = lineageOf(makeEntry({ name: "spark" }), false, { forge: "kc" });
    expect(result.inAgents).toBe(false);
  });

  it("resolves federationNode from agents first", () => {
    const result = lineageOf(
      makeEntry({ name: "spark", federation_node: "entry-node" }),
      false,
      { spark: "agents-node" },
    );
    expect(result.federationNode).toBe("agents-node");
  });

  it("falls back to entry federation_node", () => {
    const result = lineageOf(
      makeEntry({ name: "spark", federation_node: "entry-node" }),
      false,
      {},
    );
    expect(result.federationNode).toBe("entry-node");
  });

  it("returns undefined federationNode when both are null", () => {
    const result = lineageOf(makeEntry({ federation_node: null }), false, {});
    expect(result.federationNode).toBeUndefined();
  });
});

describe("timeSince", () => {
  it("returns seconds for <60s", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 30_000).toISOString();
    const result = timeSince(iso);
    expect(result).toMatch(/^\d+s$/);
  });

  it("returns minutes for 60s-60m", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    const result = timeSince(iso);
    expect(result).toMatch(/^\d+m$/);
  });

  it("returns hours for 1h-24h", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * 3600_000).toISOString();
    const result = timeSince(iso);
    expect(result).toMatch(/^\d+h$/);
  });

  it("returns days for >24h", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * 86400_000).toISOString();
    const result = timeSince(iso);
    expect(result).toMatch(/^\d+d$/);
  });

  it("returns 0s for now", () => {
    const iso = new Date().toISOString();
    const result = timeSince(iso);
    expect(result).toBe("0s");
  });
});
