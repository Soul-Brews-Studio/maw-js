/**
 * Tests for writeCache from src/core/fleet/registry-oracle-cache.ts.
 * Uses DI targetFile parameter for test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeCache } from "../../src/core/fleet/registry-oracle-cache";
import type { RegistryCache } from "../../src/core/fleet/registry-oracle-types";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-rcache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCache(overrides: Partial<RegistryCache> = {}): RegistryCache {
  return {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: "/tmp/ghq",
    oracles: [],
    ...overrides,
  } as RegistryCache;
}

describe("writeCache (with DI targetFile)", () => {
  it("creates file if it does not exist", () => {
    const target = join(tmp, "oracles.json");
    writeCache(makeCache(), target);
    expect(existsSync(target)).toBe(true);
    const data = JSON.parse(readFileSync(target, "utf-8"));
    expect(data.schema).toBe(1);
  });

  it("writes pretty-printed JSON", () => {
    const target = join(tmp, "oracles.json");
    writeCache(makeCache(), target);
    const raw = readFileSync(target, "utf-8");
    expect(raw).toContain("\n");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("preserves unknown keys from existing file", () => {
    const target = join(tmp, "oracles.json");
    writeFileSync(target, JSON.stringify({ legacy: "data", leaves: [1, 2] }));
    writeCache(makeCache(), target);
    const data = JSON.parse(readFileSync(target, "utf-8"));
    expect(data.legacy).toBe("data");
    expect(data.leaves).toEqual([1, 2]);
    expect(data.schema).toBe(1);
  });

  it("overwrites cache keys in existing file", () => {
    const target = join(tmp, "oracles.json");
    writeFileSync(target, JSON.stringify({ schema: 0, ghq_root: "/old" }));
    writeCache(makeCache({ ghq_root: "/new" }), target);
    const data = JSON.parse(readFileSync(target, "utf-8"));
    expect(data.schema).toBe(1);
    expect(data.ghq_root).toBe("/new");
  });

  it("handles malformed existing file gracefully", () => {
    const target = join(tmp, "oracles.json");
    writeFileSync(target, "not json!!!");
    writeCache(makeCache(), target);
    const data = JSON.parse(readFileSync(target, "utf-8"));
    expect(data.schema).toBe(1);
  });

  it("writes oracles array", () => {
    const target = join(tmp, "oracles.json");
    const cache = makeCache({
      oracles: [{ name: "neo", org: "Org", repo: "neo-oracle" }] as any,
    });
    writeCache(cache, target);
    const data = JSON.parse(readFileSync(target, "utf-8"));
    expect(data.oracles).toHaveLength(1);
    expect(data.oracles[0].name).toBe("neo");
  });
});
