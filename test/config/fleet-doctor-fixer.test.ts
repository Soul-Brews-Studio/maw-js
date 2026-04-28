/**
 * Tests for autoFix, colorFor, iconFor from src/commands/shared/fleet-doctor-fixer.ts.
 * Pure logic — no mocking needed (save callback is injectable).
 */
import { describe, it, expect } from "bun:test";
import { autoFix, colorFor, iconFor, C } from "../../src/commands/shared/fleet-doctor-fixer";
import type { DoctorFinding } from "../../src/commands/shared/fleet-doctor-checks";

function makeConfig(overrides: any = {}) {
  return {
    node: "my-node",
    port: 3456,
    ghqRoot: "/tmp",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    ...overrides,
  };
}

describe("colorFor", () => {
  it("returns red for error", () => expect(colorFor("error")).toBe(C.red));
  it("returns yellow for warn", () => expect(colorFor("warn")).toBe(C.yellow));
  it("returns blue for info", () => expect(colorFor("info")).toBe(C.blue));
});

describe("iconFor", () => {
  it("returns ✖ for error", () => expect(iconFor("error")).toBe("✖"));
  it("returns ⚠ for warn", () => expect(iconFor("warn")).toBe("⚠"));
  it("returns ℹ for info", () => expect(iconFor("info")).toBe("ℹ"));
});

describe("autoFix", () => {
  it("returns empty array when nothing to fix", () => {
    const config = makeConfig({ namedPeers: [{ name: "peer1", url: "http://remote:3456" }] });
    const result = autoFix([], config, () => {});
    expect(result).toEqual([]);
  });

  it("deduplicates peers by name", () => {
    const config = makeConfig({
      namedPeers: [
        { name: "peer1", url: "http://a:3456" },
        { name: "peer1", url: "http://b:3456" },
      ],
    });
    let saved: any = null;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some(r => r.includes("duplicate") && r.includes("peer1"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(1);
  });

  it("deduplicates peers by URL", () => {
    const config = makeConfig({
      namedPeers: [
        { name: "peer1", url: "http://host:3456" },
        { name: "peer2", url: "http://host:3456" },
      ],
    });
    let saved: any = null;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some(r => r.includes("duplicate") && r.includes("URL"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(1);
    expect(saved.namedPeers[0].name).toBe("peer1");
  });

  it("removes self-peer by node name", () => {
    const config = makeConfig({
      node: "my-node",
      namedPeers: [{ name: "my-node", url: "http://remote:9999" }],
    });
    let saved: any = null;
    autoFix([], config, (u) => { saved = u; });
    expect(saved.namedPeers).toHaveLength(0);
  });

  it("removes self-peer by localhost URL and port", () => {
    const config = makeConfig({
      port: 3456,
      namedPeers: [{ name: "other", url: "http://localhost:3456" }],
    });
    let saved: any = null;
    const result = autoFix([], config, (u) => { saved = u; });
    expect(result.some(r => r.includes("self-peer"))).toBe(true);
    expect(saved.namedPeers).toHaveLength(0);
  });

  it("removes self-peer on 127.0.0.1", () => {
    const config = makeConfig({
      port: 3456,
      namedPeers: [{ name: "local", url: "http://127.0.0.1:3456" }],
    });
    let saved: any = null;
    autoFix([], config, (u) => { saved = u; });
    expect(saved.namedPeers).toHaveLength(0);
  });

  it("keeps valid remote peers", () => {
    const config = makeConfig({
      namedPeers: [{ name: "remote", url: "http://other-host:3456" }],
    });
    let saved: any = null;
    autoFix([], config, (u) => { saved = u; });
    // Nothing to fix — save should not be called
    expect(saved).toBeNull();
  });

  it("auto-adds missing agents from findings", () => {
    const findings: DoctorFinding[] = [{
      level: "info",
      check: "missing-agent",
      fixable: true,
      message: "missing agent neo",
      detail: { oracle: "neo-oracle", peerNode: "remote-node" },
    }];
    const config = makeConfig();
    let saved: any = null;
    const result = autoFix(findings, config, (u) => { saved = u; });
    expect(result.some(r => r.includes("neo-oracle") && r.includes("remote-node"))).toBe(true);
    expect(saved.agents["neo-oracle"]).toBe("remote-node");
  });

  it("skips missing-agent if agent already exists", () => {
    const findings: DoctorFinding[] = [{
      level: "info",
      check: "missing-agent",
      fixable: true,
      message: "missing agent neo",
      detail: { oracle: "neo-oracle", peerNode: "remote-node" },
    }];
    const config = makeConfig({ agents: { "neo-oracle": "existing-node" } });
    let saved: any = null;
    autoFix(findings, config, (u) => { saved = u; });
    expect(saved).toBeNull();
  });

  it("skips non-fixable findings", () => {
    const findings: DoctorFinding[] = [{
      level: "error",
      check: "missing-agent",
      fixable: false,
      message: "unfixable",
      detail: { oracle: "neo", peerNode: "remote" },
    }];
    const config = makeConfig();
    let saved: any = null;
    autoFix(findings, config, (u) => { saved = u; });
    expect(saved).toBeNull();
  });

  it("does not call save when nothing changed", () => {
    let saveCalled = false;
    autoFix([], makeConfig(), () => { saveCalled = true; });
    expect(saveCalled).toBe(false);
  });

  it("handles combined dedup + self-peer + missing agent", () => {
    const config = makeConfig({
      node: "me",
      port: 3456,
      namedPeers: [
        { name: "me", url: "http://remote:9999" },
        { name: "good", url: "http://other:3456" },
        { name: "good", url: "http://other2:3456" },
      ],
    });
    const findings: DoctorFinding[] = [{
      level: "info",
      check: "missing-agent",
      fixable: true,
      message: "",
      detail: { oracle: "new-oracle", peerNode: "good" },
    }];
    let saved: any = null;
    const result = autoFix(findings, config, (u) => { saved = u; });
    expect(result.length).toBeGreaterThanOrEqual(2); // at least dedup + self-peer removal
    expect(saved.namedPeers).toHaveLength(1);
    expect(saved.namedPeers[0].name).toBe("good");
    expect(saved.agents["new-oracle"]).toBe("good");
  });
});
