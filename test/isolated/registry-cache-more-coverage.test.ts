/**
 * Extra isolated coverage for oracle registry cache I/O.
 * @maw-test-isolate
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "maw-registry-cache-"));
const cacheFile = join(root, "oracles.json");
const legacyCacheFile = join(root, "legacy-oracles.json");

mock.module(import.meta.resolve("../../src/core/fleet/registry-oracle-types.ts"), () => ({
  CACHE_FILE: cacheFile,
  LEGACY_CACHE_FILE: legacyCacheFile,
  STALE_HOURS: 24,
}));

const { isCacheStale, mergeRegistry, readCache, writeCache } = await import(
  "../../src/core/fleet/registry-oracle-cache.ts?coverage"
);

function cache(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: "/opt/Code",
    oracles: [],
    ...overrides,
  } as any;
}

beforeEach(() => {
  rmSync(cacheFile, { force: true });
  rmSync(legacyCacheFile, { force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(cacheFile, { force: true });
  rmSync(legacyCacheFile, { force: true });
});

describe("registry-oracle-cache", () => {
  test("readCache returns null for missing, malformed, and schema-mismatched cache files", () => {
    expect(readCache()).toBeNull();

    writeFileSync(cacheFile, "{ nope");
    expect(readCache()).toBeNull();

    writeFileSync(cacheFile, JSON.stringify(cache({ schema: 2 })));
    expect(readCache()).toBeNull();
  });

  test("readCache returns schema-1 cache and writeCache preserves unknown top-level keys", () => {
    writeFileSync(cacheFile, JSON.stringify({ leaves: ["legacy"], stale: true }));

    writeCache(cache({ oracles: [{ name: "maw", path: "/repo" }] }));

    const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(raw.leaves).toEqual(["legacy"]);
    expect(raw.stale).toBe(true);
    expect(readCache()?.oracles).toEqual([{ name: "maw", path: "/repo" }]);
  });

  test("mergeRegistry ignores non-object existing values and stale detection handles null and age", () => {
    expect(mergeRegistry(["not-object"], cache({ ghq_root: "/new" }))).toMatchObject({ ghq_root: "/new" });
    expect(isCacheStale(null)).toBe(true);
    expect(isCacheStale(cache({ local_scanned_at: new Date(Date.now() - 25 * 3600_000).toISOString() }))).toBe(true);
    expect(isCacheStale(cache({ local_scanned_at: new Date(Date.now() - 10 * 60_000).toISOString() }))).toBe(false);
  });

  test("writeCache falls back to fresh cache when an existing target is malformed", () => {
    const target = join(root, "custom.json");
    writeFileSync(target, "{ nope");

    writeCache(cache({ ghq_root: "/fresh" }), target);

    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({ ghq_root: "/fresh" });
  });

  test("default cache reads legacy config cache and writes forward to cache path", () => {
    writeFileSync(legacyCacheFile, JSON.stringify(cache({
      legacyKey: "preserved",
      oracles: [{ name: "legacy", repo: "legacy-oracle" }],
    })));

    expect(readCache()?.oracles).toEqual([{ name: "legacy", repo: "legacy-oracle" }]);

    writeCache(cache({ oracles: [{ name: "new", repo: "new-oracle" }] }));

    expect(existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({
      legacyKey: "preserved",
      oracles: [{ name: "new", repo: "new-oracle" }],
    });
  });
});
