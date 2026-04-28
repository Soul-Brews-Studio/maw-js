/**
 * Tests for src/core/fleet/registry-oracle-cache.ts — mergeRegistry, isCacheStale,
 * writeCache with targetFile override.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  mergeRegistry,
  isCacheStale,
  writeCache,
} from "../../src/core/fleet/registry-oracle-cache";
import type { RegistryCache } from "../../src/core/fleet/registry-oracle-types";

function makeCache(overrides: Partial<RegistryCache> = {}): RegistryCache {
  return {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: "/home/user/ghq",
    oracles: [],
    ...overrides,
  };
}

describe("mergeRegistry", () => {
  it("returns cache fields on empty existing", () => {
    const cache = makeCache();
    const result = mergeRegistry({}, cache);
    expect(result.schema).toBe(1);
    expect(result.oracles).toEqual([]);
  });

  it("preserves unknown keys from existing", () => {
    const existing = { leaves: ["a", "b"], customKey: 42 };
    const cache = makeCache();
    const result = mergeRegistry(existing, cache);
    expect(result.leaves).toEqual(["a", "b"]);
    expect(result.customKey).toBe(42);
  });

  it("cache fields override existing fields", () => {
    const existing = { schema: 0, oracles: ["old"], ghq_root: "/old" };
    const cache = makeCache({ ghq_root: "/new" });
    const result = mergeRegistry(existing, cache);
    expect(result.schema).toBe(1);
    expect(result.ghq_root).toBe("/new");
    expect(result.oracles).toEqual([]);
  });

  it("handles null existing gracefully", () => {
    const cache = makeCache();
    const result = mergeRegistry(null, cache);
    expect(result.schema).toBe(1);
  });

  it("handles array existing gracefully", () => {
    const cache = makeCache();
    const result = mergeRegistry([1, 2, 3], cache);
    expect(result.schema).toBe(1);
  });

  it("handles primitive existing gracefully", () => {
    const cache = makeCache();
    const result = mergeRegistry("string", cache);
    expect(result.schema).toBe(1);
  });
});

describe("isCacheStale", () => {
  it("returns true for null cache", () => {
    expect(isCacheStale(null)).toBe(true);
  });

  it("returns false for fresh cache", () => {
    const cache = makeCache({ local_scanned_at: new Date().toISOString() });
    expect(isCacheStale(cache)).toBe(false);
  });

  it("returns true for old cache (>1 hour)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const cache = makeCache({ local_scanned_at: twoHoursAgo });
    expect(isCacheStale(cache)).toBe(true);
  });

  it("returns false for cache just under 1 hour", () => {
    const fiftyMinAgo = new Date(Date.now() - 50 * 60_000).toISOString();
    const cache = makeCache({ local_scanned_at: fiftyMinAgo });
    expect(isCacheStale(cache)).toBe(false);
  });

  it("returns false for invalid date (NaN)", () => {
    const cache = makeCache({ local_scanned_at: "not-a-date" });
    // NaN date → ageMs = NaN → NaN > threshold = false
    expect(isCacheStale(cache)).toBe(false);
  });
});

describe("writeCache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-rcache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates file when it does not exist", () => {
    const file = join(tmp, "oracles.json");
    writeCache(makeCache(), file);
    expect(existsSync(file)).toBe(true);
  });

  it("writes valid JSON", () => {
    const file = join(tmp, "oracles.json");
    writeCache(makeCache(), file);
    const content = JSON.parse(readFileSync(file, "utf8"));
    expect(content.schema).toBe(1);
  });

  it("preserves existing unknown keys", () => {
    const file = join(tmp, "oracles.json");
    writeFileSync(file, JSON.stringify({ leaves: ["spark"], customData: true }));
    writeCache(makeCache(), file);
    const content = JSON.parse(readFileSync(file, "utf8"));
    expect(content.leaves).toEqual(["spark"]);
    expect(content.customData).toBe(true);
    expect(content.schema).toBe(1);
  });

  it("overwrites scan fields from existing", () => {
    const file = join(tmp, "oracles.json");
    writeFileSync(file, JSON.stringify({ schema: 0, ghq_root: "/old" }));
    writeCache(makeCache({ ghq_root: "/new" }), file);
    const content = JSON.parse(readFileSync(file, "utf8"));
    expect(content.ghq_root).toBe("/new");
  });

  it("handles corrupt existing file", () => {
    const file = join(tmp, "oracles.json");
    writeFileSync(file, "corrupt{{{");
    // Should not throw — falls back to fresh write
    writeCache(makeCache(), file);
    const content = JSON.parse(readFileSync(file, "utf8"));
    expect(content.schema).toBe(1);
  });

  it("file ends with newline", () => {
    const file = join(tmp, "oracles.json");
    writeCache(makeCache(), file);
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("pretty-prints with 2-space indent", () => {
    const file = join(tmp, "oracles.json");
    writeCache(makeCache(), file);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("  ");
  });
});
