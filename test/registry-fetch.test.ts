/**
 * registry-fetch: fetch + cache + TTL + fallback behavior.
 *
 * Uses file:// URLs + MAW_REGISTRY_URL / MAW_REGISTRY_CACHE env vars, so tests
 * neither hit the network nor touch ~/.maw. No mock.module required.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CACHE_TTL_MS,
  cachePath,
  getRegistry,
  isCacheFresh,
  registryUrl,
  type RegistryManifest,
} from "../src/commands/plugins/plugin/registry-fetch";

const SAMPLE: RegistryManifest = {
  schemaVersion: 1,
  updated: "2026-04-18T00:00:00Z",
  plugins: {
    "hello-maw": {
      version: "0.1.0",
      source: "https://example.com/hello-maw-0.1.0.tgz",
      sha256: "sha256:" + "a".repeat(64),
      summary: "hello plugin",
      author: "maw",
      license: "MIT",
      addedAt: "2026-04-18T00:00:00Z",
    },
  },
};

let sandbox: string;
let fixturePath: string;
let cachePathFile: string;

const savedUrl = process.env.MAW_REGISTRY_URL;
const savedCache = process.env.MAW_REGISTRY_CACHE;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "reg-fetch-"));
  fixturePath = join(sandbox, "registry.json");
  cachePathFile = join(sandbox, "cache.json");
  writeFileSync(fixturePath, JSON.stringify(SAMPLE));
  process.env.MAW_REGISTRY_URL = `file://${fixturePath}`;
  process.env.MAW_REGISTRY_CACHE = cachePathFile;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (savedUrl === undefined) delete process.env.MAW_REGISTRY_URL;
  else process.env.MAW_REGISTRY_URL = savedUrl;
  if (savedCache === undefined) delete process.env.MAW_REGISTRY_CACHE;
  else process.env.MAW_REGISTRY_CACHE = savedCache;
});

describe("registryUrl", () => {
  it("honors explicit override", () => {
    expect(registryUrl("https://x.test/r.json")).toBe("https://x.test/r.json");
  });
  it("falls back to MAW_REGISTRY_URL env", () => {
    expect(registryUrl()).toBe(`file://${fixturePath}`);
  });
});

describe("cachePath", () => {
  it("honors MAW_REGISTRY_CACHE", () => {
    expect(cachePath()).toBe(cachePathFile);
  });
});

describe("isCacheFresh", () => {
  const url = "u";
  it("fresh within TTL", () => {
    expect(isCacheFresh({ url, fetchedAt: new Date().toISOString(), manifest: SAMPLE }, url)).toBe(true);
  });
  it("stale past TTL", () => {
    const old = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    expect(isCacheFresh({ url, fetchedAt: old, manifest: SAMPLE }, url)).toBe(false);
  });
  it("stale on url mismatch", () => {
    expect(isCacheFresh({ url: "other", fetchedAt: new Date().toISOString(), manifest: SAMPLE }, url)).toBe(false);
  });
});

describe("getRegistry", () => {
  it("fetches and writes cache on miss", async () => {
    expect(existsSync(cachePathFile)).toBe(false);
    const reg = await getRegistry();
    expect(reg.plugins["hello-maw"]?.version).toBe("0.1.0");
    expect(existsSync(cachePathFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePathFile, "utf8"));
    expect(cache.url).toBe(`file://${fixturePath}`);
    expect(cache.manifest.plugins["hello-maw"]).toBeDefined();
  });

  it("returns cached manifest on hit (TTL not expired)", async () => {
    const pinned: RegistryManifest = {
      schemaVersion: 1,
      updated: "cached",
      plugins: { cached: { ...SAMPLE.plugins["hello-maw"], summary: "cached-summary" } as any },
    };
    writeFileSync(
      cachePathFile,
      JSON.stringify({
        url: `file://${fixturePath}`,
        fetchedAt: new Date().toISOString(),
        manifest: pinned,
      }),
    );
    const reg = await getRegistry();
    expect(reg.updated).toBe("cached");
    expect(reg.plugins.cached).toBeDefined();
  });

  it("falls back to stale cache on network failure (warns)", async () => {
    const pinned: RegistryManifest = {
      ...SAMPLE,
      updated: "stale",
    };
    writeFileSync(
      cachePathFile,
      JSON.stringify({
        url: `file://${fixturePath}`,
        fetchedAt: new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString(),
        manifest: pinned,
      }),
    );
    rmSync(fixturePath);
    const reg = await getRegistry();
    expect(reg.updated).toBe("stale");
  });

  it("throws when both network and cache are unavailable", async () => {
    rmSync(fixturePath);
    await expect(getRegistry()).rejects.toThrow(/registry fetch failed/);
  });

  it("rejects manifests with wrong schemaVersion", async () => {
    writeFileSync(fixturePath, JSON.stringify({ schemaVersion: 2, updated: "x", plugins: {} }));
    await expect(getRegistry()).rejects.toThrow(/invalid registry/);
  });
});
