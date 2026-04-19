/**
 * searchPeers — 2-port integration (#631).
 *
 * Spins up two real HTTP servers that mimic /api/plugin/list-manifest on
 * separately-bound ports, then calls searchPeers() against both. Exercises
 * the cache path, real JSON encode/decode, and merge across two peers.
 *
 * Uses a locally-defined native fetch wrapper (`rawFetch`) rather than
 * curlFetch. Other plugin tests `mock.module` the curl-fetch module at
 * Bun's process-global registry (see Bloom federation-audit PR #398);
 * running under test:plugin hijacks curlFetch for every subsequent test
 * in the process, which would make this test's real HTTP return ok:false.
 * rawFetch sidesteps that pollution.
 *
 * Skipped when MAW_SKIP_INTEGRATION=1 — CI shards that can't bind ports.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { searchPeers } from "../../src/commands/plugins/plugin/search-peers";
import type { PeerManifestResponse } from "../../src/api/plugin-list-manifest";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";

async function rawFetch(url: string, opts?: { timeout?: number }): Promise<CurlResponse> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts?.timeout ?? 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const SKIP = process.env.MAW_SKIP_INTEGRATION === "1";

function fakeManifest(node: string, plugins: PeerManifestResponse["plugins"]): PeerManifestResponse {
  return { schemaVersion: 1, node, pluginCount: plugins.length, plugins };
}

function startServer(manifest: PeerManifestResponse): { server: any; url: string } {
  const server = Bun.serve({
    port: 0, // OS assigns free port
    hostname: "127.0.0.1",
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/api/plugin/list-manifest") {
        return Response.json(manifest);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

describe.skipIf(SKIP)("searchPeers — 2-port integration", () => {
  let cacheDir: string;
  let serverA: ReturnType<typeof startServer>;
  let serverB: ReturnType<typeof startServer>;

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "maw-peer-int-"));
    serverA = startServer(
      fakeManifest("node-alpha", [
        { name: "example-plugin", version: "1.0.0", summary: "hello from alpha" },
        { name: "other", version: "0.1.0" },
      ]),
    );
    serverB = startServer(
      fakeManifest("node-beta", [
        { name: "example-plugin", version: "2.0.0-beta.1", summary: "hello from beta" },
      ]),
    );
  });

  afterAll(() => {
    serverA.server.stop(true);
    serverB.server.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("merges hits across two real HTTP servers (no fetch injection)", async () => {
    const r = await searchPeers("example", {
      peers: [
        { url: serverA.url, name: "alpha" },
        { url: serverB.url, name: "beta" },
      ],
      fetch: rawFetch,
      cacheDir,
      noCache: true,
    });

    expect(r.queried).toBe(2);
    expect(r.responded).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.hits).toHaveLength(2);

    const byPeer = Object.fromEntries(r.hits.map(h => [h.peerName, h]));
    expect(byPeer.alpha).toMatchObject({
      name: "example-plugin",
      version: "1.0.0",
      peerNode: "node-alpha",
      summary: "hello from alpha",
    });
    expect(byPeer.beta).toMatchObject({
      name: "example-plugin",
      version: "2.0.0-beta.1",
      peerNode: "node-beta",
    });
  });

  it("records http-error for a known-bad path", async () => {
    const r = await searchPeers("example", {
      peers: [{ url: `${serverA.url}/nope-does-not-exist-404-path`, name: "broken" }],
      fetch: rawFetch,
      cacheDir,
      noCache: true,
    });
    expect(r.responded).toBe(0);
    expect(r.errors).toHaveLength(1);
  });

  it("second call uses per-peer cache (zero additional fetches on server down)", async () => {
    const primed = await searchPeers("example", {
      peers: [{ url: serverA.url, name: "alpha" }],
      fetch: rawFetch,
      cacheDir,
    });
    expect(primed.responded).toBe(1);

    // Stop alpha; cached manifest should still serve the next query.
    serverA.server.stop(true);

    const cached = await searchPeers("example", {
      peers: [{ url: serverA.url, name: "alpha" }],
      fetch: rawFetch,
      cacheDir,
    });
    expect(cached.responded).toBe(1);
    expect(cached.hits[0]!.name).toBe("example-plugin");

    // Restart alpha for any subsequent tests (none here, but clean state).
    serverA = startServer(
      fakeManifest("node-alpha", [
        { name: "example-plugin", version: "1.0.0", summary: "hello from alpha" },
      ]),
    );
  });
});
