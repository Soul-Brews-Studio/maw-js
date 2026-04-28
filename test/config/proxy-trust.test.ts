/**
 * Tests for isReadOnlyMethod, isKnownMethod, isPathProxyable,
 * READONLY_METHODS, MUTATING_METHODS from src/api/proxy-trust.ts.
 * Pure classification + allowlist — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import {
  isReadOnlyMethod,
  isKnownMethod,
  isPathProxyable,
  READONLY_METHODS,
  MUTATING_METHODS,
} from "../../src/api/proxy-trust";

// ─── isReadOnlyMethod ───────────────────────────────────────────────────────

describe("isReadOnlyMethod", () => {
  it("returns true for GET", () => {
    expect(isReadOnlyMethod("GET")).toBe(true);
  });

  it("returns true for HEAD", () => {
    expect(isReadOnlyMethod("HEAD")).toBe(true);
  });

  it("returns true for OPTIONS", () => {
    expect(isReadOnlyMethod("OPTIONS")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isReadOnlyMethod("get")).toBe(true);
    expect(isReadOnlyMethod("Get")).toBe(true);
  });

  it("returns false for POST", () => {
    expect(isReadOnlyMethod("POST")).toBe(false);
  });

  it("returns false for DELETE", () => {
    expect(isReadOnlyMethod("DELETE")).toBe(false);
  });

  it("returns false for unknown method", () => {
    expect(isReadOnlyMethod("PURGE")).toBe(false);
  });
});

// ─── isKnownMethod ──────────────────────────────────────────────────────────

describe("isKnownMethod", () => {
  it("recognizes all readonly methods", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(isKnownMethod(m)).toBe(true);
    }
  });

  it("recognizes all mutating methods", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isKnownMethod(m)).toBe(true);
    }
  });

  it("is case insensitive", () => {
    expect(isKnownMethod("post")).toBe(true);
    expect(isKnownMethod("Patch")).toBe(true);
  });

  it("returns false for unknown method", () => {
    expect(isKnownMethod("PURGE")).toBe(false);
    expect(isKnownMethod("TRACE")).toBe(false);
  });
});

// ─── Sets ───────────────────────────────────────────────────────────────────

describe("READONLY_METHODS", () => {
  it("contains exactly 3 methods", () => {
    expect(READONLY_METHODS.size).toBe(3);
  });

  it("contains GET, HEAD, OPTIONS", () => {
    expect(READONLY_METHODS.has("GET")).toBe(true);
    expect(READONLY_METHODS.has("HEAD")).toBe(true);
    expect(READONLY_METHODS.has("OPTIONS")).toBe(true);
  });
});

describe("MUTATING_METHODS", () => {
  it("contains exactly 4 methods", () => {
    expect(MUTATING_METHODS.size).toBe(4);
  });

  it("contains POST, PUT, PATCH, DELETE", () => {
    expect(MUTATING_METHODS.has("POST")).toBe(true);
    expect(MUTATING_METHODS.has("PUT")).toBe(true);
    expect(MUTATING_METHODS.has("PATCH")).toBe(true);
    expect(MUTATING_METHODS.has("DELETE")).toBe(true);
  });
});

// ─── isPathProxyable ────────────────────────────────────────────────────────

describe("isPathProxyable", () => {
  it("allows /api/config", () => {
    expect(isPathProxyable("/api/config")).toBe(true);
  });

  it("allows /api/fleet-config", () => {
    expect(isPathProxyable("/api/fleet-config")).toBe(true);
  });

  it("allows /api/feed", () => {
    expect(isPathProxyable("/api/feed")).toBe(true);
  });

  it("allows /api/plugins", () => {
    expect(isPathProxyable("/api/plugins")).toBe(true);
  });

  it("allows /api/federation/status", () => {
    expect(isPathProxyable("/api/federation/status")).toBe(true);
  });

  it("allows /api/sessions", () => {
    expect(isPathProxyable("/api/sessions")).toBe(true);
  });

  it("allows /api/worktrees", () => {
    expect(isPathProxyable("/api/worktrees")).toBe(true);
  });

  it("allows /api/teams", () => {
    expect(isPathProxyable("/api/teams")).toBe(true);
  });

  it("allows /api/ping", () => {
    expect(isPathProxyable("/api/ping")).toBe(true);
  });

  it("denies prefix match (security: no path traversal)", () => {
    expect(isPathProxyable("/api/worktrees/cleanup")).toBe(false);
  });

  it("denies unknown paths", () => {
    expect(isPathProxyable("/api/admin")).toBe(false);
    expect(isPathProxyable("/api/secret")).toBe(false);
    expect(isPathProxyable("/")).toBe(false);
  });

  it("strips query string before matching", () => {
    expect(isPathProxyable("/api/feed?limit=10")).toBe(true);
    expect(isPathProxyable("/api/admin?bypass=true")).toBe(false);
  });

  it("denies empty path", () => {
    expect(isPathProxyable("")).toBe(false);
  });
});
