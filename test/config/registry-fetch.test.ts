/**
 * Tests for src/commands/plugins/plugin/registry-fetch.ts
 * — registryUrl, isCacheFresh (pure functions).
 */
import { describe, it, expect } from "bun:test";
import {
  registryUrl,
  isCacheFresh,
  DEFAULT_REGISTRY_URL,
  CACHE_TTL_MS,
} from "../../src/commands/plugins/plugin/registry-fetch";

describe("registryUrl", () => {
  it("returns override when provided", () => {
    expect(registryUrl("https://custom.com/reg.json")).toBe("https://custom.com/reg.json");
  });

  it("returns default when no override and no env", () => {
    const old = process.env.MAW_REGISTRY_URL;
    delete process.env.MAW_REGISTRY_URL;
    try {
      expect(registryUrl()).toBe(DEFAULT_REGISTRY_URL);
    } finally {
      if (old !== undefined) process.env.MAW_REGISTRY_URL = old;
    }
  });

  it("returns env override when no arg", () => {
    const old = process.env.MAW_REGISTRY_URL;
    process.env.MAW_REGISTRY_URL = "https://env.com/r.json";
    try {
      expect(registryUrl()).toBe("https://env.com/r.json");
    } finally {
      if (old !== undefined) process.env.MAW_REGISTRY_URL = old;
      else delete process.env.MAW_REGISTRY_URL;
    }
  });

  it("prefers arg over env", () => {
    const old = process.env.MAW_REGISTRY_URL;
    process.env.MAW_REGISTRY_URL = "https://env.com/r.json";
    try {
      expect(registryUrl("https://arg.com/r.json")).toBe("https://arg.com/r.json");
    } finally {
      if (old !== undefined) process.env.MAW_REGISTRY_URL = old;
      else delete process.env.MAW_REGISTRY_URL;
    }
  });
});

describe("isCacheFresh", () => {
  const makeCache = (url: string, fetchedAt: string) => ({
    url,
    fetchedAt,
    manifest: { schemaVersion: 1 as const, updated: "", plugins: {} },
  });

  it("returns true for fresh cache (just fetched)", () => {
    const now = Date.now();
    const cache = makeCache("https://x.com", new Date(now - 1000).toISOString());
    expect(isCacheFresh(cache, "https://x.com", now)).toBe(true);
  });

  it("returns false for stale cache (past TTL)", () => {
    const now = Date.now();
    const cache = makeCache("https://x.com", new Date(now - CACHE_TTL_MS - 1).toISOString());
    expect(isCacheFresh(cache, "https://x.com", now)).toBe(false);
  });

  it("returns false for URL mismatch", () => {
    const now = Date.now();
    const cache = makeCache("https://old.com", new Date(now).toISOString());
    expect(isCacheFresh(cache, "https://new.com", now)).toBe(false);
  });

  it("returns true at exactly TTL boundary (age = TTL - 1)", () => {
    const now = Date.now();
    const cache = makeCache("https://x.com", new Date(now - CACHE_TTL_MS + 1).toISOString());
    expect(isCacheFresh(cache, "https://x.com", now)).toBe(true);
  });

  it("returns false at exactly TTL", () => {
    const now = Date.now();
    const cache = makeCache("https://x.com", new Date(now - CACHE_TTL_MS).toISOString());
    expect(isCacheFresh(cache, "https://x.com", now)).toBe(false);
  });

  it("returns false for future fetchedAt (negative age)", () => {
    const now = Date.now();
    const cache = makeCache("https://x.com", new Date(now + 10000).toISOString());
    // age would be negative → age >= 0 fails
    expect(isCacheFresh(cache, "https://x.com", now)).toBe(false);
  });

  it("CACHE_TTL_MS is 5 minutes", () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
