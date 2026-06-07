/** Focused isolated coverage for src/commands/plugins/plugin/search-peers.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PeerManifestResponse } from "../../src/api/plugin-list-manifest";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";

type NamedPeer = { name: string; url: string };

let config: { namedPeers?: NamedPeer[] };
let peerUrls: string[];
let cacheDir: string;

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => config,
}));

mock.module(import.meta.resolve("../../src/core/transport/peers"), () => ({
  getPeers: () => peerUrls,
}));

const search = await import("../../src/commands/plugins/plugin/search-peers.ts?plugin-search-peers-next-coverage");

function manifestOk(node: string, plugins: PeerManifestResponse["plugins"]): CurlResponse {
  return {
    ok: true,
    status: 200,
    data: {
      schemaVersion: 1,
      node,
      pluginCount: plugins.length,
      plugins,
    } satisfies PeerManifestResponse,
  };
}

function cacheFile(url: string): string {
  return join(cacheDir, `${encodeURIComponent(url).replace(/%/g, "_")}.json`);
}

beforeEach(() => {
  config = { namedPeers: [] };
  peerUrls = [];
  cacheDir = mkdtempSync(join(tmpdir(), "maw-plugin-search-peers-next-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("searchPeers next coverage", () => {
  test("resolvePeers uses named config for explicit peers and maps peer URLs back to names", () => {
    config = {
      namedPeers: [
        { name: "node-a", url: "http://a.local:3456" },
        { name: "node-b", url: "http://b.local:3456" },
      ],
    };
    peerUrls = ["http://b.local:3456", "http://loose.local:3456"];

    expect(search.resolvePeers({ peer: "node-a" })).toEqual([
      { name: "node-a", url: "http://a.local:3456" },
    ]);
    expect(search.resolvePeers({})).toEqual([
      { name: "node-b", url: "http://b.local:3456" },
      { url: "http://loose.local:3456" },
    ]);
    expect(() => search.resolvePeers({ peer: "missing" })).toThrow("unknown peer 'missing'");
  });

  test("corrupt peer cache is ignored and refreshed from the peer", async () => {
    const url = "http://cache.local:3456";
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile(url), "{ not json", "utf8");
    let calls = 0;

    const result = await search.searchPeers("gem", {
      peers: [{ url, name: "cache-node" }],
      cacheDir,
      totalMs: 20,
      fetch: (async () => {
        calls++;
        return manifestOk("cache-node", [
          { name: "gem", version: "1.0.0", summary: "cached gem" },
        ]);
      }) as any,
    });

    expect(calls).toBe(1);
    expect(result.responded).toBe(1);
    expect(result.hits[0]).toMatchObject({
      name: "gem",
      version: "1.0.0",
      peerName: "cache-node",
    });
  });

  test("fetch exceptions become unreachable peer errors without throwing", async () => {
    const result = await search.searchPeers("gem", {
      peers: [{ url: "http://boom.local:3456", name: "boom" }],
      cacheDir,
      noCache: true,
      totalMs: 20,
      fetch: (async () => {
        throw "socket closed";
      }) as any,
    });

    expect(result.hits).toEqual([]);
    expect(result.responded).toBe(0);
    expect(result.errors).toEqual([
      {
        peerUrl: "http://boom.local:3456",
        peerName: "boom",
        reason: "unreachable",
        detail: "socket closed",
      },
    ]);
  });

  test("bad manifests are rejected while cache write failures stay non-fatal", async () => {
    const cacheBlocker = join(cacheDir, "not-a-directory");
    writeFileSync(cacheBlocker, "blocks mkdir", "utf8");

    const result = await search.searchPeers("tool", {
      peers: [
        { url: "http://bad.local:3456", name: "bad" },
        { url: "http://good.local:3456", name: "good" },
      ],
      cacheDir: cacheBlocker,
      totalMs: 20,
      fetch: (async (url: string) => {
        if (url.startsWith("http://bad.local")) {
          return {
            ok: true,
            status: 200,
            data: {
              schemaVersion: 1,
              node: "bad",
              plugins: [{ name: "tool-without-version" }],
            },
          } as CurlResponse;
        }
        return manifestOk("good", [
          { name: "tool", version: "2.0.0", author: "Maw", sha256: null },
        ]);
      }) as any,
    });

    expect(result.errors).toEqual([
      {
        peerUrl: "http://bad.local:3456",
        peerName: "bad",
        reason: "bad-response",
        detail: "missing schemaVersion=1/plugins[]",
      },
    ]);
    expect(result.hits).toEqual([
      {
        name: "tool",
        version: "2.0.0",
        author: "Maw",
        peerName: "good",
        peerNode: "good",
        peerUrl: "http://good.local:3456",
        sha256: null,
      },
    ]);
  });
});
