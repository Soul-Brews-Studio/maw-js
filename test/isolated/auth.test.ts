/**
 * Tests for createToken, verifyToken, extractToken from src/lib/auth.ts.
 * Mocks config to avoid loading real config for JWT_SECRET fallback.
 */
import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "auth-"));

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
  loadConfig: () => ({
    node: "test-node",
    ghqRoot: tmp,
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
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

const { createToken, verifyToken, extractToken } = await import("../../src/lib/auth");

describe("createToken", () => {
  it("returns a string with two parts separated by dot", () => {
    const token = createToken();
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("creates a token that can be verified", () => {
    const token = createToken();
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.node).toBe("test-node");
  });

  it("includes iat and exp in payload", () => {
    const token = createToken();
    const payload = verifyToken(token);
    expect(payload!.iat).toBeGreaterThan(0);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it("token expires 24h from now", () => {
    const before = Date.now();
    const token = createToken();
    const payload = verifyToken(token);
    const after = Date.now();
    const expected24h = 24 * 60 * 60 * 1000;
    expect(payload!.exp - payload!.iat).toBe(expected24h);
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
  });
});

describe("verifyToken", () => {
  it("returns null for empty string", () => {
    expect(verifyToken("")).toBeNull();
  });

  it("returns null for single part (no dot)", () => {
    expect(verifyToken("nodot")).toBeNull();
  });

  it("returns null for three parts", () => {
    expect(verifyToken("a.b.c")).toBeNull();
  });

  it("returns null for tampered payload", () => {
    const token = createToken();
    const parts = token.split(".");
    // Tamper with the payload
    const tampered = "dGFtcGVyZWQ" + "." + parts[1];
    expect(verifyToken(tampered)).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = createToken();
    const parts = token.split(".");
    const tampered = parts[0] + ".badsig";
    expect(verifyToken(tampered)).toBeNull();
  });

  it("returns null for invalid base64 payload", () => {
    expect(verifyToken("!!!.abc")).toBeNull();
  });
});

describe("extractToken", () => {
  it("extracts from Bearer authorization header", () => {
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Bearer my-token-123" },
    });
    expect(extractToken(req)).toBe("my-token-123");
  });

  it("extracts from query parameter", () => {
    const req = new Request("http://localhost/api?token=query-token-456");
    expect(extractToken(req)).toBe("query-token-456");
  });

  it("returns null when no token present", () => {
    const req = new Request("http://localhost/api");
    expect(extractToken(req)).toBeNull();
  });

  it("prefers Bearer header over query parameter", () => {
    const req = new Request("http://localhost/api?token=query", {
      headers: { Authorization: "Bearer header" },
    });
    expect(extractToken(req)).toBe("header");
  });

  it("ignores non-Bearer auth schemes", () => {
    const req = new Request("http://localhost/api", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractToken(req)).toBeNull();
  });
});
