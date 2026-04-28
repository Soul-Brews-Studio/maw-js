/**
 * Tests for resolveBindHost from src/core/bind-host.ts.
 * Fully DI-injectable — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { resolveBindHost } from "../../src/core/bind-host";
import type { BindConfig, BindHostEnv, PeersStoreReader } from "../../src/core/bind-host";

describe("resolveBindHost", () => {
  const noEnv: BindHostEnv = {};
  const noPeers: PeersStoreReader = () => ({ peers: {} });

  it("returns loopback when no peers configured", () => {
    const result = resolveBindHost({}, noEnv, noPeers);
    expect(result.hostname).toBe("127.0.0.1");
    expect(result.reason).toBeNull();
  });

  it("returns 0.0.0.0 when config.peers is non-empty", () => {
    const config: BindConfig = { peers: ["http://peer:3456"] };
    const result = resolveBindHost(config, noEnv, noPeers);
    expect(result.hostname).toBe("0.0.0.0");
    expect(result.reason).toBe("config.peers");
  });

  it("returns 0.0.0.0 when config.namedPeers is non-empty", () => {
    const config: BindConfig = { namedPeers: [{ name: "mba", url: "http://mba:3456" }] };
    const result = resolveBindHost(config, noEnv, noPeers);
    expect(result.hostname).toBe("0.0.0.0");
    expect(result.reason).toBe("config.namedPeers");
  });

  it("returns 0.0.0.0 when MAW_HOST is 0.0.0.0", () => {
    const result = resolveBindHost({}, { MAW_HOST: "0.0.0.0" }, noPeers);
    expect(result.hostname).toBe("0.0.0.0");
    expect(result.reason).toBe("MAW_HOST");
  });

  it("returns 0.0.0.0 when peers.json has entries", () => {
    const reader: PeersStoreReader = () => ({ peers: { "mba": { url: "http://mba" } } });
    const result = resolveBindHost({}, noEnv, reader);
    expect(result.hostname).toBe("0.0.0.0");
    expect(result.reason).toBe("peers.json");
  });

  it("config.peers takes priority over MAW_HOST", () => {
    const config: BindConfig = { peers: ["http://peer"] };
    const result = resolveBindHost(config, { MAW_HOST: "0.0.0.0" }, noPeers);
    expect(result.reason).toBe("config.peers");
  });

  it("config.namedPeers takes priority over MAW_HOST", () => {
    const config: BindConfig = { namedPeers: [{ name: "x" }] };
    const result = resolveBindHost(config, { MAW_HOST: "0.0.0.0" }, noPeers);
    expect(result.reason).toBe("config.namedPeers");
  });

  it("ignores empty peers arrays", () => {
    const config: BindConfig = { peers: [], namedPeers: [] };
    const result = resolveBindHost(config, noEnv, noPeers);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("ignores null peers", () => {
    const config: BindConfig = { peers: null, namedPeers: null };
    const result = resolveBindHost(config, noEnv, noPeers);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("handles peers reader throwing", () => {
    const badReader: PeersStoreReader = () => { throw new Error("fail"); };
    const result = resolveBindHost({}, noEnv, badReader);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("handles empty peers store", () => {
    const reader: PeersStoreReader = () => ({ peers: {} });
    const result = resolveBindHost({}, noEnv, reader);
    expect(result.hostname).toBe("127.0.0.1");
  });
});
