/**
 * Tests for resolveProxyPeerUrl from src/api/proxy-relay.ts.
 * Uses mock.module to stub loadConfig — isolated test in config dir
 * since the function is small and self-contained.
 */
import { describe, it, expect, mock } from "bun:test";

// Mock config to avoid filesystem read
mock.module("../../src/config", () => ({
  loadConfig: () => ({
    namedPeers: [
      { name: "mba", url: "http://mba.local:3456" },
      { name: "kc", url: "http://kc.tailnet:3456" },
    ],
  }),
}));

const { resolveProxyPeerUrl } = await import("../../src/api/proxy-relay");

describe("resolveProxyPeerUrl", () => {
  it("resolves named peer", () => {
    expect(resolveProxyPeerUrl("mba")).toBe("http://mba.local:3456");
  });

  it("resolves another named peer", () => {
    expect(resolveProxyPeerUrl("kc")).toBe("http://kc.tailnet:3456");
  });

  it("returns null for unknown peer name", () => {
    expect(resolveProxyPeerUrl("unknown")).toBeNull();
  });

  it("wraps host:port in http://", () => {
    expect(resolveProxyPeerUrl("myhost.local:8080")).toBe("http://myhost.local:8080");
  });

  it("passes through http:// URLs", () => {
    expect(resolveProxyPeerUrl("http://example.com")).toBe("http://example.com");
  });

  it("passes through https:// URLs", () => {
    expect(resolveProxyPeerUrl("https://example.com")).toBe("https://example.com");
  });

  it("returns null for bare hostname without port", () => {
    expect(resolveProxyPeerUrl("justahostname")).toBeNull();
  });
});
