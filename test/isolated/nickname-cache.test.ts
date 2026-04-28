/**
 * Tests for nickname cache functions from src/core/fleet/nicknames.ts:
 * readCache, writeCache, getCachedNickname, setCachedNickname, resolveNickname.
 * Uses mock.module to redirect resolveHome() to temp dir.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "nick-cache-"));

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const {
  readCache,
  writeCache,
  getCachedNickname,
  setCachedNickname,
  resolveNickname,
  cacheFile,
} = await import("../../src/core/fleet/nicknames");

describe("cacheFile", () => {
  it("returns path under resolveHome", () => {
    expect(cacheFile()).toBe(join(tmp, "nicknames.json"));
  });
});

describe("readCache + writeCache", () => {
  it("returns empty cache when file missing", () => {
    const cache = readCache();
    expect(cache.schema).toBe(1);
    expect(cache.nicknames).toEqual({});
  });

  it("round-trips cache data", () => {
    const data = { schema: 1 as const, nicknames: { neo: "The One", pulse: "Watcher" } };
    writeCache(data);
    const read = readCache();
    expect(read.nicknames.neo).toBe("The One");
    expect(read.nicknames.pulse).toBe("Watcher");
  });

  it("handles malformed JSON gracefully", () => {
    writeFileSync(cacheFile(), "not json", "utf-8");
    const cache = readCache();
    expect(cache.nicknames).toEqual({});
  });

  it("handles JSON without nicknames key", () => {
    writeFileSync(cacheFile(), JSON.stringify({ other: "stuff" }), "utf-8");
    const cache = readCache();
    expect(cache.nicknames).toEqual({});
  });
});

describe("getCachedNickname", () => {
  beforeEach(() => {
    writeCache({ schema: 1, nicknames: { neo: "The One" } });
  });

  it("returns cached value when present", () => {
    expect(getCachedNickname("neo")).toBe("The One");
  });

  it("returns null when not in cache", () => {
    expect(getCachedNickname("unknown")).toBeNull();
  });
});

describe("setCachedNickname", () => {
  beforeEach(() => {
    writeCache({ schema: 1, nicknames: {} });
  });

  it("adds nickname to cache", () => {
    setCachedNickname("neo", "The One");
    expect(getCachedNickname("neo")).toBe("The One");
  });

  it("removes nickname when empty string", () => {
    setCachedNickname("neo", "The One");
    setCachedNickname("neo", "");
    expect(getCachedNickname("neo")).toBeNull();
  });

  it("preserves other entries when setting", () => {
    setCachedNickname("neo", "The One");
    setCachedNickname("pulse", "Watcher");
    expect(getCachedNickname("neo")).toBe("The One");
    expect(getCachedNickname("pulse")).toBe("Watcher");
  });
});

describe("resolveNickname", () => {
  beforeEach(() => {
    writeCache({ schema: 1, nicknames: {} });
  });

  it("returns cached nickname first", () => {
    setCachedNickname("neo", "Cached");
    expect(resolveNickname("neo", null)).toBe("Cached");
  });

  it("returns null when no cache and no repo path", () => {
    expect(resolveNickname("unknown", null)).toBeNull();
  });

  it("returns null when no cache and repo has no nickname file", () => {
    expect(resolveNickname("unknown", "/tmp/nonexistent-repo")).toBeNull();
  });
});
