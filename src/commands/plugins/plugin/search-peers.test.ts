/**
 * searchPeers — unit tests (#631).
 *
 * Fully hermetic: every test injects `fetch` and `peers`, and points the
 * per-peer cache at a per-test tmpdir. No real HTTP, no ~/.maw writes.
 * Follows the SymmetricDeps-style injection pattern from the federation
 * audit (PR #398) — no mock.module process-global pollution.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  searchPeers,
  peerCacheDir,
  DEFAULT_PER_PEER_MS,
  DEFAULT_TOTAL_MS,
} from "./search-peers";
import type { CurlResponse } from "../../../core/transport/curl-fetch";
import type { PeerManifestResponse } from "../../../api/plugin-list-manifest";

function manifestOk(node: string, plugins: PeerManifestResponse["plugins"]): CurlResponse {
  const data: PeerManifestResponse = {
    schemaVersion: 1,
    node,
    pluginCount: plugins.length,
    plugins,
  };
  return { ok: true, status: 200, data };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "maw-peer-cache-"));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("searchPeers — empty + basic", () => {
  it("returns empty result when peers list is empty", async () => {
    const r = await searchPeers("anything", { peers: [], cacheDir });
    expect(r.hits).toEqual([]);
    expect(r.queried).toBe(0);
    expect(r.responded).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("finds a hit by name with one peer", async () => {
    const fetchImpl = async () =>
      manifestOk("white", [
        { name: "example", version: "1.0.0", summary: "hello" },
        { name: "other", version: "0.1.0", summary: "nope" },
      ]);
    const r = await searchPeers("example", {
      peers: [{ url: "http://a:3456", name: "white" }],
      fetch: fetchImpl as any,
      cacheDir,
      noCache: true,
    });
    expect(r.queried).toBe(1);
    expect(r.responded).toBe(1);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({
      name: "example",
      version: "1.0.0",
      peerUrl: "http://a:3456",
      peerName: "white",
      peerNode: "white",
    });
  });

  it("matches on summary when name does not hit", async () => {
    const fetchImpl = async () =>
      manifestOk("n", [
        { name: "abc", version: "1.0.0", summary: "draws tarot cards" },
      ]);
    const r = await searchPeers("tarot", {
      peers: [{ url: "http://b:3456" }],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.name).toBe("abc");
  });
});

describe("searchPeers — merge + dedupe", () => {
  it("returns one hit per (name, version, peer) — same plugin from two peers surfaces twice", async () => {
    const fetchImpl = async (url: string) => {
      if (url.startsWith("http://a")) return manifestOk("A", [{ name: "tool", version: "1.0.0" }]);
      return manifestOk("B", [{ name: "tool", version: "1.0.0" }]);
    };
    const r = await searchPeers("tool", {
      peers: [
        { url: "http://a:3456", name: "alpha" },
        { url: "http://b:3456", name: "beta" },
      ],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.responded).toBe(2);
    expect(r.hits).toHaveLength(2);
    expect(r.hits.map(h => h.peerName).sort()).toEqual(["alpha", "beta"]);
  });

  it("sorts hits by name then version", async () => {
    const fetchImpl = async () =>
      manifestOk("n", [
        { name: "beta", version: "1.0.0" },
        { name: "alpha", version: "2.0.0" },
        { name: "alpha", version: "1.0.0" },
      ]);
    const r = await searchPeers("a", {
      peers: [{ url: "http://one:3456" }],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.hits.map(h => `${h.name}@${h.version}`)).toEqual([
      "alpha@1.0.0",
      "alpha@2.0.0",
      "beta@1.0.0",
    ]);
  });
});

describe("searchPeers — errors", () => {
  it("surfaces unreachable peer in errors[] without throwing", async () => {
    const fetchImpl = async () => ({ ok: false, status: 0, data: null } as CurlResponse);
    const r = await searchPeers("x", {
      peers: [{ url: "http://dead:3456", name: "ghost" }],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toEqual([]);
    expect(r.responded).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      peerUrl: "http://dead:3456",
      peerName: "ghost",
      reason: "unreachable",
    });
  });

  it("classifies HTTP error (e.g. 404, old peer) as http-error", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, data: null } as CurlResponse);
    const r = await searchPeers("x", {
      peers: [{ url: "http://old:3456" }],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.errors[0]!.reason).toBe("http-error");
    expect(r.errors[0]!.detail).toContain("404");
  });

  it("classifies missing schemaVersion as bad-response", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, data: { plugins: "not an array" } } as CurlResponse);
    const r = await searchPeers("x", {
      peers: [{ url: "http://weird:3456" }],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.errors[0]!.reason).toBe("bad-response");
  });

  it("surviving peers still return hits when one fails", async () => {
    const fetchImpl = async (url: string) => {
      if (url.startsWith("http://dead")) return { ok: false, status: 0, data: null } as CurlResponse;
      return manifestOk("live", [{ name: "gem", version: "1.0.0" }]);
    };
    const r = await searchPeers("gem", {
      peers: [
        { url: "http://dead:3456" },
        { url: "http://live:3456" },
      ],
      fetch: fetchImpl as any,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.peerUrl).toBe("http://live:3456");
    expect(r.errors).toHaveLength(1);
  });

  it("total-budget timeout marks every peer with reason=timeout", async () => {
    const fetchImpl = async (url: string, opts?: { timeout?: number }) => {
      await new Promise(r => setTimeout(r, 200));
      return manifestOk("slow", []);
    };
    const r = await searchPeers("x", {
      peers: [{ url: "http://slow:3456" }],
      fetch: fetchImpl as any,
      totalMs: 20,
      perPeerMs: 20,
      noCache: true,
      cacheDir,
    });
    expect(r.responded).toBe(0);
    expect(r.errors[0]!.reason).toBe("timeout");
  });
});

describe("searchPeers — cache", () => {
  it("second call reads from cache without hitting fetch again", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return manifestOk("cached", [{ name: "gem", version: "1.0.0" }]);
    };
    const peers = [{ url: "http://c:3456" }];
    const a = await searchPeers("gem", { peers, fetch: fetchImpl as any, cacheDir });
    const b = await searchPeers("gem", { peers, fetch: fetchImpl as any, cacheDir });
    expect(a.hits).toHaveLength(1);
    expect(b.hits).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("noCache bypasses cache reads and writes", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return manifestOk("n", [{ name: "gem", version: "1.0.0" }]);
    };
    const peers = [{ url: "http://d:3456" }];
    await searchPeers("gem", { peers, fetch: fetchImpl as any, cacheDir, noCache: true });
    await searchPeers("gem", { peers, fetch: fetchImpl as any, cacheDir, noCache: true });
    expect(calls).toBe(2);
  });
});

describe("searchPeers — defaults + peerCacheDir", () => {
  it("default timeouts are sane", () => {
    expect(DEFAULT_PER_PEER_MS).toBeGreaterThan(0);
    expect(DEFAULT_TOTAL_MS).toBeGreaterThanOrEqual(DEFAULT_PER_PEER_MS);
  });

  it("peerCacheDir honors override", () => {
    expect(peerCacheDir("/tmp/foo")).toBe("/tmp/foo");
  });

  it("peerCacheDir honors MAW_PEER_CACHE_DIR env when no override", () => {
    const saved = process.env.MAW_PEER_CACHE_DIR;
    try {
      process.env.MAW_PEER_CACHE_DIR = "/tmp/maw-env-test";
      expect(peerCacheDir()).toBe("/tmp/maw-env-test");
    } finally {
      if (saved === undefined) delete process.env.MAW_PEER_CACHE_DIR;
      else process.env.MAW_PEER_CACHE_DIR = saved;
    }
  });
});
