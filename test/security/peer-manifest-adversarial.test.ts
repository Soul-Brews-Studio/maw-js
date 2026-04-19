/**
 * Peer manifest adversarial harness (#633).
 *
 * Shape A of search-peers (#631) treats peer manifests as *advisory*: the
 * actual trust boundary is plugins.lock (#487), which verifies sha256 at
 * install time. This harness exercises the seams in between — what a
 * hostile peer can try to smuggle through the discovery path — and
 * classifies each case:
 *
 *   PASS         — searchPeers defends correctly (or the threat is not
 *                  reachable at this layer by construction).
 *   FAIL-KNOWN   — there is an actual gap; a follow-up issue is filed and
 *                  the test documents the current behavior.
 *   FAIL-BLOCKER — gap is critical and fixed in this PR.
 *
 * Hermetic: every test injects `fetch` + `peers` + `cacheDir`. No real
 * network, no ~/.maw writes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { searchPeers } from "../../src/commands/plugins/plugin/search-peers";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";

// ─── Harness ─────────────────────────────────────────────────────────────────

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "maw-adversarial-"));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Build a mock peer that replies with arbitrary raw `data` (already parsed JSON). */
function mockPeer(data: unknown, opts: { status?: number; ok?: boolean } = {}): typeof import("../../src/core/transport/curl-fetch").curlFetch {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return (async () => ({ ok, status, data } as CurlResponse)) as any;
}

// ─── Case 1 — Spoofed source URL ─────────────────────────────────────────────
// Classification: PASS
// Reason: `peerUrl` in search hits is taken from the caller-configured peer
// URL, never from the manifest body. The manifest has no `source` field in
// the schema, so a hostile peer cannot redirect install to an attacker URL
// via the discovery channel. Verified: an attempt to embed `source:
// "https://evil/"` is ignored.
describe("spoofed source URL", () => {
  test("manifest.source is ignored; peerUrl is the configured URL", async () => {
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "white",
      pluginCount: 1,
      plugins: [{ name: "example", version: "1.0.0" }],
      // Hostile extras — attacker tries to redirect install:
      source: "https://evil.example/",
      tarballUrl: "https://evil.example/payload.tgz",
    });
    const r = await searchPeers("example", {
      peers: [{ url: "http://white:3456", name: "white" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    const hit = r.hits[0]!;
    expect(hit.peerUrl).toBe("http://white:3456");
    // No field named `source` / `tarballUrl` should surface on the hit.
    expect((hit as any).source).toBeUndefined();
    expect((hit as any).tarballUrl).toBeUndefined();
  });
});

// ─── Case 2 — Manifest vs tarball sha256 mismatch ───────────────────────────
// Classification: PASS (by design).
// Reason: search-peers displays the sha256 the peer claims as advisory
// metadata only. The trust boundary at install time is plugins.lock
// (#487), which recomputes the sha256 of the actual tarball and refuses
// if it drifts (see test/isolated/plugin-lock.test.ts §"pinned with hash
// mismatch"). This test pins that contract: the discovery hit is *not*
// the thing that authorizes install.
describe("manifest-vs-tarball sha256 mismatch", () => {
  test("searchPeers surfaces the manifest-claimed sha256 verbatim; install-time lock is the checker", async () => {
    const fakeSha = "sha256:" + "0".repeat(64); // would never match a real artifact
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "white",
      pluginCount: 1,
      plugins: [{ name: "example", version: "1.0.0", sha256: fakeSha }],
    });
    const r = await searchPeers("example", {
      peers: [{ url: "http://white:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.sha256).toBe(fakeSha);
    // No install happens here — search is discovery only. plugins.lock
    // (tested in test/isolated/plugin-lock.test.ts) is what refuses a
    // mismatched tarball at install time.
  });
});

// ─── Case 3 — Identity swap ─────────────────────────────────────────────────
// Classification: FIXED (#651, PR that flipped this test).
// Reason: searchPeers now cross-checks `manifest.node` against the
// config-trusted `namedPeers[].name`. A hostile peer at `http://white:3456`
// that claims `node: "attacker"` still gets the forged value surfaced (so
// callers can see what was claimed), but `identityMismatch: true` flags
// the hit and a stderr warning is emitted. Callers (install, trust
// decisions) MUST check `identityMismatch` before routing through
// `peerNode`.
describe("identity swap (peer claims another node's name)", () => {
  test("mismatch is flagged: identityMismatch=true + stderr warn, peerNode preserved as evidence", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }) as typeof console.warn;
    try {
      const fetchImpl = mockPeer({
        schemaVersion: 1,
        node: "attacker", // lies — real peer is "white"
        pluginCount: 1,
        plugins: [{ name: "example", version: "1.0.0" }],
      });
      const r = await searchPeers("example", {
        peers: [{ url: "http://white:3456", name: "white" }],
        fetch: fetchImpl,
        noCache: true,
        cacheDir,
      });
      expect(r.hits).toHaveLength(1);
      // The forged value is still surfaced so operators can see what the
      // peer tried to claim — but identityMismatch flags it as untrusted.
      expect(r.hits[0]!.peerNode).toBe("attacker");
      expect(r.hits[0]!.peerName).toBe("white");
      expect(r.hits[0]!.peerUrl).toBe("http://white:3456");
      expect(r.hits[0]!.identityMismatch).toBe(true);
      // Stderr warning names the peer URL, configured name, and claimed node.
      expect(warnings.some(w =>
        w.includes("identity mismatch") &&
        w.includes("http://white:3456") &&
        w.includes("'white'") &&
        w.includes("'attacker'"),
      )).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("honest peer (node matches configured name) → no mismatch flag, no warn", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }) as typeof console.warn;
    try {
      const fetchImpl = mockPeer({
        schemaVersion: 1,
        node: "white",
        pluginCount: 1,
        plugins: [{ name: "example", version: "1.0.0" }],
      });
      const r = await searchPeers("example", {
        peers: [{ url: "http://white:3456", name: "white" }],
        fetch: fetchImpl,
        noCache: true,
        cacheDir,
      });
      expect(r.hits).toHaveLength(1);
      expect(r.hits[0]!.identityMismatch).toBeUndefined();
      expect(warnings.some(w => w.includes("identity mismatch"))).toBe(false);
    } finally {
      console.warn = origWarn;
    }
  });

  test("unnamed peer (no configured name) → no mismatch flag (nothing to compare against)", async () => {
    // When a peer is listed only by URL (flat peers[], not namedPeers[]),
    // there is no trusted name to compare against. Don't flag — the
    // operator explicitly opted into an unnamed peer.
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "whoever",
      pluginCount: 1,
      plugins: [{ name: "example", version: "1.0.0" }],
    });
    const r = await searchPeers("example", {
      peers: [{ url: "http://anon:3456" }], // no name
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.identityMismatch).toBeUndefined();
    expect(r.hits[0]!.peerNode).toBe("whoever");
  });
});

// ─── Case 4 — Oversized manifest ────────────────────────────────────────────
// Classification: FAIL-KNOWN (follow-up).
// Reason: curlFetch does not impose a response-body size cap, so a peer
// can force the client to buffer an arbitrarily large manifest. In the
// unit test we prove the library processes a 10k-plugin manifest without
// protest; wall-clock ordering is also preserved (`elapsedMs` is real).
// Follow-up: add a size cap in curlFetch (e.g. 2 MiB default, configurable
// via `opts.maxBytes`) and a plugin-count sanity cap in search-peers.
describe("oversized manifest", () => {
  test("FAIL-KNOWN: 10k-plugin manifest is processed wholesale (no size cap)", async () => {
    const plugins = Array.from({ length: 10_000 }, (_, i) => ({
      name: `pkg-${i.toString().padStart(5, "0")}`,
      version: "1.0.0",
      summary: "x".repeat(100),
    }));
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "whale",
      pluginCount: plugins.length,
      plugins,
    });
    const r = await searchPeers("pkg-0", {
      peers: [{ url: "http://whale:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    // Every one of the 10k entries matches "pkg-0" as a substring; no limit.
    expect(r.hits.length).toBeGreaterThanOrEqual(10_000);
    expect(r.responded).toBe(1);
  });
});

// ─── Case 5 — Bogus field types ─────────────────────────────────────────────
// Classification: PASS.
// Reason: isManifest() in search-peers.ts rejects any plugin entry where
// `name` or `version` is not a string. The peer response is classified as
// bad-response and recorded in errors[].
describe("bogus field types", () => {
  test("version as integer → bad-response", async () => {
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "typo",
      pluginCount: 1,
      plugins: [{ name: "example", version: 123 }],
    });
    const r = await searchPeers("example", {
      peers: [{ url: "http://typo:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.reason).toBe("bad-response");
  });

  test("schemaVersion wrong (=2) → bad-response", async () => {
    const fetchImpl = mockPeer({
      schemaVersion: 2,
      node: "future",
      pluginCount: 0,
      plugins: [],
    });
    const r = await searchPeers("anything", {
      peers: [{ url: "http://future:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.errors[0]!.reason).toBe("bad-response");
  });

  test("plugins is not an array → bad-response", async () => {
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "n",
      pluginCount: 0,
      plugins: "surprise",
    });
    const r = await searchPeers("anything", {
      peers: [{ url: "http://n:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.errors[0]!.reason).toBe("bad-response");
  });

  test("name missing entirely → bad-response", async () => {
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "n",
      pluginCount: 1,
      plugins: [{ version: "1.0.0" }],
    });
    const r = await searchPeers("anything", {
      peers: [{ url: "http://n:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.errors[0]!.reason).toBe("bad-response");
  });
});

// ─── Case 6 — Prototype pollution ───────────────────────────────────────────
// Classification: PASS.
// Reason: search-peers never uses a key from the manifest as a dynamic
// object property (no `obj[attacker.key] = ...` patterns). `__proto__` as
// a plugin name is treated as an opaque string by dedupe's Set<string>.
// This test pins that: a peer returning `name: "__proto__"` does not
// corrupt Object.prototype.
describe("prototype pollution", () => {
  test("__proto__ as plugin name does not pollute Object.prototype", async () => {
    const sentinelBefore = ({} as any).polluted;
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "n",
      pluginCount: 1,
      plugins: [{ name: "__proto__", version: "1.0.0", summary: "innocent" }],
    });
    const r = await searchPeers("__proto__", {
      peers: [{ url: "http://n:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.name).toBe("__proto__");
    // Ensure Object.prototype is untouched.
    expect(({} as any).polluted).toBe(sentinelBefore);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  test("nested __proto__ mass-assignment attempt is not unpacked", async () => {
    // The manifest has a plugin entry with `__proto__: { polluted: true }`.
    // Since search-peers never does `Object.assign(target, entry)` with
    // attacker-controlled keys, nothing should happen. The entry is also
    // missing required fields, so it's rejected at isManifest().
    const hostile: any = {
      schemaVersion: 1,
      node: "n",
      pluginCount: 1,
      plugins: [{ name: "ok", version: "1.0.0", ["__proto__"]: { polluted: true } }],
    };
    const fetchImpl = mockPeer(hostile);
    await searchPeers("ok", {
      peers: [{ url: "http://n:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(({} as any).polluted).toBeUndefined();
  });
});

// ─── Case 7 — Duplicate plugins ─────────────────────────────────────────────
// Classification: PASS.
// Reason: searchPeers dedupes by `name@version@peerUrl` via a Set. A peer
// returning 10× the same (name, version) collapses to a single hit.
describe("duplicate plugins in a single manifest", () => {
  test("10× same plugin from one peer → 1 hit", async () => {
    const dup = Array.from({ length: 10 }, () => ({
      name: "same", version: "1.0.0", summary: "s",
    }));
    const fetchImpl = mockPeer({
      schemaVersion: 1,
      node: "dup",
      pluginCount: dup.length,
      plugins: dup,
    });
    const r = await searchPeers("same", {
      peers: [{ url: "http://dup:3456" }],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.name).toBe("same");
  });

  test("same plugin across two peers → 2 hits (dedupe is per-peer)", async () => {
    const fetchImpl = (async (url: string) => ({
      ok: true, status: 200,
      data: {
        schemaVersion: 1,
        node: url.includes("a:") ? "A" : "B",
        pluginCount: 1,
        plugins: [{ name: "same", version: "1.0.0" }],
      },
    })) as any;
    const r = await searchPeers("same", {
      peers: [
        { url: "http://a:3456", name: "alpha" },
        { url: "http://b:3456", name: "beta" },
      ],
      fetch: fetchImpl,
      noCache: true,
      cacheDir,
    });
    expect(r.hits).toHaveLength(2);
    expect(r.hits.map(h => h.peerName).sort()).toEqual(["alpha", "beta"]);
  });
});
