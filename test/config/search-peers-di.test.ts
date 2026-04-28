/**
 * Tests for searchPeers() from src/commands/plugins/plugin/search-peers.ts
 * using its built-in dependency injection (opts.fetch, opts.peers, opts.noCache).
 * No mock.module needed — pure DI testing.
 */
import { describe, it, expect } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  searchPeers,
  type SearchPeersOpts,
  type PluginSearchHit,
} from "../../src/commands/plugins/plugin/search-peers";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";
import type { PeerManifestResponse } from "../../src/api/plugin-list-manifest";

function makeManifest(node: string, plugins: { name: string; version: string; summary?: string; author?: string; sha256?: string | null }[]): PeerManifestResponse {
  return { schemaVersion: 1, node, pluginCount: plugins.length, plugins };
}

function makeFetch(responses: Map<string, CurlResponse>): (url: string, opts?: any) => Promise<CurlResponse> {
  return async (url: string) => {
    const res = responses.get(url);
    if (!res) return { ok: false, status: 0, data: null };
    return res;
  };
}

function okResponse(manifest: PeerManifestResponse): CurlResponse {
  return { ok: true, status: 200, data: manifest };
}

describe("searchPeers with DI", () => {
  it("returns empty when no peers", async () => {
    const result = await searchPeers("test", { peers: [], noCache: true });
    expect(result.hits).toEqual([]);
    expect(result.queried).toBe(0);
    expect(result.responded).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("returns matching plugins from a single peer", async () => {
    const manifest = makeManifest("neo", [
      { name: "hello-world", version: "1.0.0", summary: "A greeting plugin" },
      { name: "goodbye", version: "2.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://peer1:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("hello", {
      peers: [{ url: "http://peer1:3456", name: "neo" }],
      fetch,
      noCache: true,
    });

    expect(result.queried).toBe(1);
    expect(result.responded).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("hello-world");
    expect(result.hits[0].peerUrl).toBe("http://peer1:3456");
    expect(result.hits[0].peerName).toBe("neo");
    expect(result.hits[0].peerNode).toBe("neo");
  });

  it("matches on summary text too", async () => {
    const manifest = makeManifest("pulse", [
      { name: "metrics", version: "1.0.0", summary: "CPU and memory monitoring" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://peer1:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("monitoring", {
      peers: [{ url: "http://peer1:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("metrics");
  });

  it("case-insensitive matching", async () => {
    const manifest = makeManifest("neo", [
      { name: "HelloWorld", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("HELLOWORLD", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.hits).toHaveLength(1);
  });

  it("merges results from multiple peers", async () => {
    const m1 = makeManifest("neo", [{ name: "alpha", version: "1.0.0" }]);
    const m2 = makeManifest("pulse", [{ name: "alpha-ext", version: "2.0.0" }]);
    const fetch = makeFetch(new Map([
      ["http://p1:3456/api/plugin/list-manifest", okResponse(m1)],
      ["http://p2:3456/api/plugin/list-manifest", okResponse(m2)],
    ]));

    const result = await searchPeers("alpha", {
      peers: [
        { url: "http://p1:3456", name: "neo" },
        { url: "http://p2:3456", name: "pulse" },
      ],
      fetch,
      noCache: true,
    });

    expect(result.queried).toBe(2);
    expect(result.responded).toBe(2);
    expect(result.hits).toHaveLength(2);
    const names = result.hits.map(h => h.name);
    expect(names).toContain("alpha");
    expect(names).toContain("alpha-ext");
  });

  it("deduplicates same plugin from same peer", async () => {
    const manifest = makeManifest("neo", [
      { name: "dupe", version: "1.0.0" },
      { name: "dupe", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("dupe", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.hits).toHaveLength(1);
  });

  it("sorts results by name then version", async () => {
    const manifest = makeManifest("neo", [
      { name: "zeta", version: "1.0.0" },
      { name: "alpha", version: "2.0.0" },
      { name: "alpha", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("a", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    const sorted = result.hits.map(h => `${h.name}@${h.version}`);
    expect(sorted).toEqual(["alpha@1.0.0", "alpha@2.0.0", "zeta@1.0.0"]);
  });

  it("reports unreachable peer in errors", async () => {
    const fetch = async () => { throw new Error("connection refused"); };

    const result = await searchPeers("test", {
      peers: [{ url: "http://dead:3456", name: "ghost" }],
      fetch,
      noCache: true,
    });

    expect(result.queried).toBe(1);
    expect(result.responded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("unreachable");
    expect(result.errors[0].peerName).toBe("ghost");
  });

  it("reports HTTP error in errors", async () => {
    const fetch = async () => ({ ok: false, status: 500, data: null });

    const result = await searchPeers("test", {
      peers: [{ url: "http://err:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("http-error");
    expect(result.errors[0].detail).toContain("500");
  });

  it("reports bad-response when manifest schema is wrong", async () => {
    const fetch = async () => ({ ok: true, status: 200, data: { wrong: "shape" } });

    const result = await searchPeers("test", {
      peers: [{ url: "http://bad:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("bad-response");
  });

  it("preserves sha256 in hits", async () => {
    const manifest = makeManifest("neo", [
      { name: "signed", version: "1.0.0", sha256: "a".repeat(64) },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("signed", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.hits[0].sha256).toBe("a".repeat(64));
  });

  it("preserves summary and author in hits", async () => {
    const manifest = makeManifest("neo", [
      { name: "fancy", version: "1.0.0", summary: "A fancy plugin", author: "neo" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("fancy", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.hits[0].summary).toBe("A fancy plugin");
    expect(result.hits[0].author).toBe("neo");
  });

  it("flags identity mismatch when peer reports different node", async () => {
    const manifest = makeManifest("impersonator", [
      { name: "evil", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("evil", {
      peers: [{ url: "http://p:3456", name: "trusted-neo" }],
      fetch,
      noCache: true,
    });

    expect(result.hits[0].identityMismatch).toBe(true);
    expect(result.hits[0].peerNode).toBe("impersonator");
    expect(result.hits[0].peerName).toBe("trusted-neo");
  });

  it("no identity mismatch when node matches peer name", async () => {
    const manifest = makeManifest("neo", [
      { name: "legit", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("legit", {
      peers: [{ url: "http://p:3456", name: "neo" }],
      fetch,
      noCache: true,
    });

    expect(result.hits[0].identityMismatch).toBeUndefined();
  });

  it("returns no hits when query matches nothing", async () => {
    const manifest = makeManifest("neo", [
      { name: "abc", version: "1.0.0" },
    ]);
    const fetch = makeFetch(new Map([
      ["http://p:3456/api/plugin/list-manifest", okResponse(manifest)],
    ]));

    const result = await searchPeers("zzz-nonexistent", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });

    expect(result.responded).toBe(1);
    expect(result.hits).toHaveLength(0);
  });

  it("tracks elapsed time", async () => {
    const fetch = async () => okResponse(makeManifest("neo", []));
    const result = await searchPeers("x", {
      peers: [{ url: "http://p:3456" }],
      fetch,
      noCache: true,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(5000);
  });

  it("mixes successful and failed peers", async () => {
    const manifest = makeManifest("neo", [
      { name: "found-it", version: "1.0.0" },
    ]);
    let callCount = 0;
    const fetch = async (url: string) => {
      if (url.includes("good")) return okResponse(manifest);
      throw new Error("offline");
    };

    const result = await searchPeers("found", {
      peers: [
        { url: "http://good:3456", name: "neo" },
        { url: "http://bad:3456", name: "ghost" },
      ],
      fetch,
      noCache: true,
    });

    expect(result.queried).toBe(2);
    expect(result.responded).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });
});

describe("searchPeers caching", () => {
  let tmp: string;

  function setup() {
    tmp = join(tmpdir(), `maw-test-peer-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    return tmp;
  }

  function cleanup() {
    rmSync(tmp, { recursive: true, force: true });
  }

  it("writes cache on successful fetch", async () => {
    setup();
    const manifest = makeManifest("neo", [{ name: "cached", version: "1.0.0" }]);
    const fetch = async () => okResponse(manifest);

    await searchPeers("cached", {
      peers: [{ url: "http://cache-test:3456" }],
      fetch,
      cacheDir: tmp,
    });

    // Cache dir should now have a file
    const files = require("fs").readdirSync(tmp);
    expect(files.length).toBeGreaterThan(0);
    cleanup();
  });

  it("reads from cache on second call (no fetch needed)", async () => {
    setup();
    const manifest = makeManifest("neo", [{ name: "cached", version: "1.0.0" }]);
    let fetchCount = 0;
    const fetch = async () => {
      fetchCount++;
      return okResponse(manifest);
    };

    // First call — fetches
    await searchPeers("cached", {
      peers: [{ url: "http://cache-hit:3456" }],
      fetch,
      cacheDir: tmp,
    });
    expect(fetchCount).toBe(1);

    // Second call — should use cache
    const result = await searchPeers("cached", {
      peers: [{ url: "http://cache-hit:3456" }],
      fetch,
      cacheDir: tmp,
    });
    expect(fetchCount).toBe(1); // no second fetch
    expect(result.hits).toHaveLength(1);
    cleanup();
  });

  it("noCache skips cache read", async () => {
    setup();
    const manifest = makeManifest("neo", [{ name: "nocache", version: "1.0.0" }]);
    let fetchCount = 0;
    const fetch = async () => {
      fetchCount++;
      return okResponse(manifest);
    };

    // First call with cache
    await searchPeers("nocache", {
      peers: [{ url: "http://nc:3456" }],
      fetch,
      cacheDir: tmp,
    });

    // Second call with noCache — should re-fetch
    await searchPeers("nocache", {
      peers: [{ url: "http://nc:3456" }],
      fetch,
      noCache: true,
      cacheDir: tmp,
    });
    expect(fetchCount).toBe(2);
    cleanup();
  });
});
