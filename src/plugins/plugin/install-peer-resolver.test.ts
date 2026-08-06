/**
 * resolvePeerInstall — unit tests (Task #1).
 *
 * Injects `searchImpl` so tests never touch the network or namedPeers
 * config. Covers the five failure modes from docs/plugins/at-peer-install.md §5
 * plus the happy path.
 */
import { describe, it, expect } from "bun:test";
import { resolvePeerInstall } from "./install-peer-resolver";
import type { SearchPeersResult, PluginSearchHit } from "./search-peers";

function hit(over: Partial<PluginSearchHit>): PluginSearchHit {
  return {
    name: "ping",
    version: "1.0.0",
    peerUrl: "http://peer.internal:2700",
    peerNode: "mawjs-parent",
    peerName: "mawjs-parent",
    sha256: "sha256:abc123deadbeef",
    ...over,
  };
}

function okResult(hits: PluginSearchHit[]): SearchPeersResult {
  return { hits, queried: 1, responded: 1, errors: [], elapsedMs: 5 };
}

describe("resolvePeerInstall — happy path", () => {
  it("returns downloadUrl synthesized from peerUrl + plugin name", async () => {
    const r = await resolvePeerInstall("ping", "mawjs-parent", {
      searchImpl: async () => okResult([hit({})]),
    });
    expect(r.downloadUrl).toBe("http://peer.internal:2700/api/plugin/download/ping");
    expect(r.peerSha256).toBe("sha256:abc123deadbeef");
    expect(r.peerName).toBe("mawjs-parent");
    expect(r.peerNode).toBe("mawjs-parent");
    expect(r.version).toBe("1.0.0");
    // #644 Phase 3 — peerUrl threaded through for the consent gate.
    expect(r.peerUrl).toBe("http://peer.internal:2700");
  });

  it("percent-encodes the plugin name in the download URL", async () => {
    const r = await resolvePeerInstall("name-with-dash", "peer1", {
      searchImpl: async () => okResult([hit({ name: "name-with-dash" })]),
    });
    expect(r.downloadUrl).toBe("http://peer.internal:2700/api/plugin/download/name-with-dash");
  });

  it("falls back to the peer-spec name when searchPeers doesn't include peerName", async () => {
    const r = await resolvePeerInstall("ping", "mawjs-parent", {
      searchImpl: async () =>
        okResult([hit({ peerName: undefined })]),
    });
    expect(r.peerName).toBe("mawjs-parent"); // from the user input
  });
});

describe("resolvePeerInstall — failure modes", () => {
  it("surfaces peer offline as an actionable error", async () => {
    await expect(
      resolvePeerInstall("ping", "mawjs-parent", {
        searchImpl: async () => ({
          hits: [],
          queried: 1,
          responded: 0,
          elapsedMs: 2,
          errors: [
            {
              peerUrl: "http://peer.internal:2700",
              peerName: "mawjs-parent",
              reason: "unreachable",
              detail: "ECONNREFUSED",
            },
          ],
        }),
      }),
    ).rejects.toThrow(/peer 'mawjs-parent' unreachable — ECONNREFUSED/);
  });

  it("explicitly surfaces timeout errors with retry hint", async () => {
    await expect(
      resolvePeerInstall("ping", "mawjs-parent", {
        searchImpl: async () => ({
          hits: [],
          queried: 1,
          responded: 0,
          elapsedMs: 4000,
          errors: [
            {
              peerUrl: "http://peer.internal:2700",
              peerName: "mawjs-parent",
              reason: "timeout",
              detail: "total budget 4000ms exceeded",
            },
          ],
        }),
      }),
    ).rejects.toThrow(/retry with: maw plugin install ping@mawjs-parent/);
  });

  it("lists available matches when the named plugin is not on the peer", async () => {
    try {
      await resolvePeerInstall("ping", "mawjs-parent", {
        searchImpl: async () =>
          okResult([hit({ name: "pingpong", version: "0.2.0" })]),
      });
      throw new Error("expected resolvePeerInstall to throw");
    } catch (e: any) {
      expect(e.message).toContain("no plugin named 'ping' on peer 'mawjs-parent'");
      expect(e.message).toContain("pingpong@0.2.0");
    }
  });

  it("omits the 'available matches' clause when peer responded with zero hits", async () => {
    await expect(
      resolvePeerInstall("ping", "mawjs-parent", {
        searchImpl: async () => okResult([]),
      }),
    ).rejects.toThrow(/no plugin named 'ping' on peer 'mawjs-parent'$/);
  });

  it("rejects ambiguous multi-version responses", async () => {
    await expect(
      resolvePeerInstall("ping", "mawjs-parent", {
        searchImpl: async () =>
          okResult([hit({ version: "1.0.0" }), hit({ version: "2.0.0" })]),
      }),
    ).rejects.toThrow(/ambiguous install.*1\.0\.0, 2\.0\.0/);
  });

  it("rethrows unknown-peer errors from searchPeers unchanged", async () => {
    await expect(
      resolvePeerInstall("ping", "no-such-peer", {
        searchImpl: async () => {
          throw new Error("unknown peer 'no-such-peer' — not in namedPeers");
        },
      }),
    ).rejects.toThrow(/unknown peer 'no-such-peer'/);
  });
});
