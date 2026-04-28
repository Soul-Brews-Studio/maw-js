/**
 * Tests for checkStalePeers from src/commands/shared/fleet-doctor-stale-peers.ts.
 * Mocks curlFetch via sdk to test peer liveness check logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "stale-peers-"));

let fetchResponses = new Map<string, any>();

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({ ghqRoot: tmp, node: "test", agents: {}, namedPeers: [], peers: [], triggers: [], port: 3456 }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/core/transport/curl-fetch", () => ({
  curlFetch: async (url: string) => {
    const res = fetchResponses.get(url);
    if (res === "throw") throw new Error("unreachable");
    return res ?? { ok: false, status: 0, data: null };
  },
}));

const { checkStalePeers } = await import(
  "../../src/commands/shared/fleet-doctor-stale-peers"
);

beforeEach(() => {
  fetchResponses = new Map();
});

describe("checkStalePeers", () => {
  it("returns empty findings for no peers", async () => {
    const result = await checkStalePeers([]);
    expect(result.findings).toEqual([]);
    expect(result.identities).toEqual({});
  });

  it("records identity for healthy peer", async () => {
    fetchResponses.set("http://peer:3456/api/identity", {
      ok: true, status: 200,
      data: { node: "neo-node", agents: ["neo-oracle", "pulse-oracle"] },
    });

    const result = await checkStalePeers([
      { name: "neo", url: "http://peer:3456" },
    ]);

    expect(result.findings).toHaveLength(0);
    expect(result.identities.neo.node).toBe("neo-node");
    expect(result.identities.neo.agents).toEqual(["neo-oracle", "pulse-oracle"]);
  });

  it("warns for non-ok response", async () => {
    fetchResponses.set("http://peer:3456/api/identity", {
      ok: false, status: 500, data: null,
    });

    const result = await checkStalePeers([
      { name: "broken", url: "http://peer:3456" },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].check).toBe("stale-peer");
    expect(result.findings[0].level).toBe("warn");
    expect(result.findings[0].message).toContain("broken");
  });

  it("warns for unreachable peer (fetch throws)", async () => {
    fetchResponses.set("http://dead:3456/api/identity", "throw");

    const result = await checkStalePeers([
      { name: "ghost", url: "http://dead:3456" },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("unreachable");
  });

  it("handles mixed healthy and unhealthy peers", async () => {
    fetchResponses.set("http://good:3456/api/identity", {
      ok: true, status: 200,
      data: { node: "good-node", agents: ["neo"] },
    });
    fetchResponses.set("http://bad:3456/api/identity", "throw");

    const result = await checkStalePeers([
      { name: "good", url: "http://good:3456" },
      { name: "bad", url: "http://bad:3456" },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.identities.good).toBeDefined();
    expect(result.identities.bad).toBeUndefined();
  });

  it("filters non-string agents from identity", async () => {
    fetchResponses.set("http://peer:3456/api/identity", {
      ok: true, status: 200,
      data: { node: "test", agents: ["valid", 42, null, "also-valid"] },
    });

    const result = await checkStalePeers([
      { name: "mixed", url: "http://peer:3456" },
    ]);

    expect(result.identities.mixed.agents).toEqual(["valid", "also-valid"]);
  });

  it("skips identity when response data is malformed", async () => {
    fetchResponses.set("http://peer:3456/api/identity", {
      ok: true, status: 200,
      data: { wrong: "shape" }, // no node or agents
    });

    const result = await checkStalePeers([
      { name: "malformed", url: "http://peer:3456" },
    ]);

    expect(result.findings).toHaveLength(0);
    expect(result.identities.malformed).toBeUndefined();
  });

  it("findings are not fixable", async () => {
    fetchResponses.set("http://peer:3456/api/identity", "throw");

    const result = await checkStalePeers([
      { name: "test", url: "http://peer:3456" },
    ]);

    expect(result.findings[0].fixable).toBe(false);
  });
});
