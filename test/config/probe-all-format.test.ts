/**
 * Tests for src/commands/plugins/peers/probe-all.ts — formatProbeAll.
 * Pure string formatting function.
 */
import { describe, it, expect } from "bun:test";
import { formatProbeAll, type ProbeAllResult } from "../../src/commands/plugins/peers/probe-all";

function makeResult(overrides: Partial<ProbeAllResult> = {}): ProbeAllResult {
  return {
    rows: [],
    okCount: 0,
    failCount: 0,
    worstExitCode: 0,
    ...overrides,
  };
}

describe("formatProbeAll", () => {
  it("returns 'no peers' for empty result", () => {
    expect(formatProbeAll(makeResult())).toBe("no peers");
  });

  it("shows header row", () => {
    const result = makeResult({
      rows: [{ alias: "neo", url: "http://neo:3456", node: "neo-node", lastSeen: "2025-01-01", ok: true, ms: 42 }],
      okCount: 1,
    });
    const output = formatProbeAll(result);
    expect(output).toContain("alias");
    expect(output).toContain("url");
    expect(output).toContain("node");
    expect(output).toContain("result");
  });

  it("shows ✓ for successful peers", () => {
    const result = makeResult({
      rows: [{ alias: "neo", url: "http://neo:3456", node: "n", lastSeen: null, ok: true, ms: 10 }],
      okCount: 1,
    });
    const output = formatProbeAll(result);
    expect(output).toContain("✓");
    expect(output).toContain("ok");
    expect(output).toContain("10ms");
  });

  it("shows ✗ for failed peers", () => {
    const result = makeResult({
      rows: [{ alias: "bad", url: "http://bad:3456", node: null, lastSeen: null, ok: false, ms: 2000, error: { code: "TIMEOUT" as any, message: "timed out", ts: "" } }],
      failCount: 1,
    });
    const output = formatProbeAll(result);
    expect(output).toContain("✗");
    expect(output).toContain("TIMEOUT");
  });

  it("shows summary line with ok/total count", () => {
    const result = makeResult({
      rows: [
        { alias: "a", url: "http://a", node: "a", lastSeen: null, ok: true, ms: 5 },
        { alias: "b", url: "http://b", node: null, lastSeen: null, ok: false, ms: 100, error: { code: "ERR" as any, message: "", ts: "" } },
      ],
      okCount: 1,
      failCount: 1,
    });
    const output = formatProbeAll(result);
    expect(output).toContain("1/2 ok");
    expect(output).toContain("1 failed");
  });

  it("shows dash for null node", () => {
    const result = makeResult({
      rows: [{ alias: "x", url: "http://x", node: null, lastSeen: null, ok: true, ms: 1 }],
      okCount: 1,
    });
    const output = formatProbeAll(result);
    expect(output).toContain("-");
  });

  it("has separator line between header and data", () => {
    const result = makeResult({
      rows: [{ alias: "z", url: "http://z", node: "z", lastSeen: "now", ok: true, ms: 5 }],
      okCount: 1,
    });
    const lines = formatProbeAll(result).split("\n");
    // Second line should be dashes
    expect(lines[1]).toMatch(/^-+/);
  });

  it("does not mention failed when all ok", () => {
    const result = makeResult({
      rows: [{ alias: "a", url: "http://a", node: "a", lastSeen: null, ok: true, ms: 1 }],
      okCount: 1,
      failCount: 0,
    });
    const output = formatProbeAll(result);
    expect(output).not.toContain("failed");
  });
});
