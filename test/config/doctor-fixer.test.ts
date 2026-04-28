/**
 * Tests for src/commands/shared/fleet-doctor-fixer.ts — colorFor, iconFor, autoFix.
 * autoFix is pure when save callback is injected.
 */
import { describe, it, expect } from "bun:test";
import { colorFor, iconFor, autoFix, C } from "../../src/commands/shared/fleet-doctor-fixer";
import type { DoctorFinding } from "../../src/commands/shared/fleet-doctor-checks";
import type { MawConfig } from "../../src/config";

// ─── colorFor / iconFor ──────────────────────────────────────────

describe("colorFor", () => {
  it("returns red for error", () => {
    expect(colorFor("error")).toBe(C.red);
  });

  it("returns yellow for warn", () => {
    expect(colorFor("warn")).toBe(C.yellow);
  });

  it("returns blue for info", () => {
    expect(colorFor("info")).toBe(C.blue);
  });
});

describe("iconFor", () => {
  it("returns ✖ for error", () => {
    expect(iconFor("error")).toBe("✖");
  });

  it("returns ⚠ for warn", () => {
    expect(iconFor("warn")).toBe("⚠");
  });

  it("returns ℹ for info", () => {
    expect(iconFor("info")).toBe("ℹ");
  });
});

// ─── autoFix ─────────────────────────────────────────────────────

describe("autoFix", () => {
  const baseConfig: MawConfig = {
    node: "white",
    port: 7777,
    namedPeers: [],
    agents: {},
  } as any;

  function noopSave(_update: Partial<MawConfig>): void {}

  it("returns empty array when no fixable findings", () => {
    const result = autoFix([], baseConfig, noopSave);
    expect(result).toEqual([]);
  });

  it("deduplicates peers by name", () => {
    const config = {
      ...baseConfig,
      namedPeers: [
        { name: "peer1", url: "http://a:7777" },
        { name: "peer1", url: "http://b:7777" },
      ],
    } as any;
    let saved: any;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some((r) => r.includes("duplicate peer 'peer1'"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(1);
  });

  it("deduplicates peers by URL", () => {
    const config = {
      ...baseConfig,
      namedPeers: [
        { name: "peer1", url: "http://a:7777" },
        { name: "peer2", url: "http://a:7777" },
      ],
    } as any;
    const result = autoFix([], config, noopSave);
    expect(result.some((r) => r.includes("duplicate peer URL"))).toBe(true);
  });

  it("removes self-peer by name match", () => {
    const config = {
      ...baseConfig,
      namedPeers: [
        { name: "white", url: "http://other:8888" },
        { name: "remote", url: "http://remote:7777" },
      ],
    } as any;
    let saved: any;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some((r) => r.includes("self-peer 'white'"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(1);
    expect(saved.namedPeers[0].name).toBe("remote");
  });

  it("removes self-peer by localhost URL", () => {
    const config = {
      ...baseConfig,
      namedPeers: [
        { name: "me", url: "http://localhost:7777" },
      ],
    } as any;
    let saved: any;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some((r) => r.includes("self-peer"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(0);
  });

  it("auto-adds missing agents from findings", () => {
    const findings: DoctorFinding[] = [
      {
        check: "missing-agent",
        level: "warn",
        message: "missing agent",
        fixable: true,
        detail: { oracle: "neo", peerNode: "black" },
      },
    ];
    let saved: any;
    const result = autoFix(findings, baseConfig, (u) => { saved = u; });
    expect(result.some((r) => r.includes("added config.agents['neo']"))).toBe(true);
    expect(saved.agents.neo).toBe("black");
  });

  it("does not overwrite existing agent entry", () => {
    const config = {
      ...baseConfig,
      agents: { neo: "existing" },
    } as any;
    const findings: DoctorFinding[] = [
      {
        check: "missing-agent",
        level: "warn",
        message: "missing",
        fixable: true,
        detail: { oracle: "neo", peerNode: "black" },
      },
    ];
    const result = autoFix(findings, config, noopSave);
    expect(result.every((r) => !r.includes("neo"))).toBe(true);
  });

  it("does not call save when nothing changed", () => {
    let called = false;
    autoFix([], baseConfig, () => { called = true; });
    expect(called).toBe(false);
  });
});
