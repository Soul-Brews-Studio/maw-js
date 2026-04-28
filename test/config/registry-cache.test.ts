/**
 * Tests for mergeRegistry and isCacheStale from src/core/fleet/registry-oracle-cache.ts.
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { mergeRegistry, isCacheStale } from "../../src/core/fleet/registry-oracle-cache";
import type { RegistryCache } from "../../src/core/fleet/registry-oracle-types";

function makeCache(overrides: Partial<RegistryCache> = {}): RegistryCache {
  return {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: "/tmp/ghq",
    oracles: [],
    ...overrides,
  } as RegistryCache;
}

// ─── mergeRegistry ──────────────────────────────────────────────────────────

describe("mergeRegistry", () => {
  it("returns cache as-is when existing is null", () => {
    const cache = makeCache();
    const result = mergeRegistry(null, cache);
    expect(result.schema).toBe(1);
    expect(result.oracles).toEqual([]);
  });

  it("returns cache as-is when existing is not an object", () => {
    const cache = makeCache();
    expect(mergeRegistry("string", cache)).toMatchObject({ schema: 1 });
    expect(mergeRegistry(42, cache)).toMatchObject({ schema: 1 });
    expect(mergeRegistry([], cache)).toMatchObject({ schema: 1 });
  });

  it("merges cache over existing object", () => {
    const existing = { schema: 1, legacy: "preserved", oracles: [{ name: "old" }] };
    const cache = makeCache({ oracles: [{ name: "new" }] as any });
    const result = mergeRegistry(existing, cache);
    // Cache fields overwrite
    expect((result.oracles as any)[0].name).toBe("new");
    // Unknown keys preserved
    expect(result.legacy).toBe("preserved");
  });

  it("preserves top-level keys not in cache", () => {
    const existing = { leaves: ["a", "b"], custom: true };
    const cache = makeCache();
    const result = mergeRegistry(existing, cache);
    expect(result.leaves).toEqual(["a", "b"]);
    expect(result.custom).toBe(true);
  });

  it("overwrites existing keys with cache values", () => {
    const existing = { schema: 0, ghq_root: "/old" };
    const cache = makeCache({ ghq_root: "/new" });
    const result = mergeRegistry(existing, cache);
    expect(result.schema).toBe(1);
    expect(result.ghq_root).toBe("/new");
  });
});

// ─── isCacheStale ───────────────────────────────────────────────────────────

describe("isCacheStale", () => {
  it("returns true for null cache", () => {
    expect(isCacheStale(null)).toBe(true);
  });

  it("returns false for freshly created cache", () => {
    expect(isCacheStale(makeCache())).toBe(false);
  });

  it("returns true for very old cache", () => {
    const old = makeCache({ local_scanned_at: "2020-01-01T00:00:00Z" });
    expect(isCacheStale(old)).toBe(true);
  });

  it("returns false for cache scanned 1 hour ago", () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    expect(isCacheStale(makeCache({ local_scanned_at: recent }))).toBe(false);
  });
});
