/**
 * Scenario 03 — offline peer surfaces as an error without dropping live hits (#655 Phase 2).
 *
 * Two peers: one is taken offline via PeerHandle.setOffline(true) before
 * the search. Expected: the live peer's hit is still returned, and the
 * offline peer shows up in `errors[]` with reason=unreachable — never
 * silently dropped. This is the "partial success" contract that keeps
 * federated discovery useful when one node is down.
 */

import type { Scenario } from "../scenario";
import { searchPeers } from "../../../src/commands/plugins/plugin/search-peers";

const scenario: Scenario = {
  name: "03-search-offline",
  backends: ["emulated"],
  peers: 2,
  async setUp(peers) {
    await peers[0]!.installPlugin({ name: "livegem", version: "1.0.0" });
    await peers[1]!.installPlugin({ name: "deadgem", version: "1.0.0" });
    await peers[1]!.setOffline(true);
  },
  async assert(peers) {
    const result = await searchPeers("gem", {
      peers: peers.map(p => ({ url: p.url, name: p.node })),
      noCache: true,
      perPeerMs: 1000,
      totalMs: 3000,
    });

    if (result.queried !== 2) {
      throw new Error(`expected queried=2, got ${result.queried}`);
    }
    if (result.responded !== 1) {
      throw new Error(`expected responded=1 (one peer offline), got ${result.responded}`);
    }

    if (result.hits.length !== 1 || result.hits[0]!.name !== "livegem") {
      throw new Error(`expected exactly livegem hit, got ${JSON.stringify(result.hits)}`);
    }
    if (result.hits[0]!.peerUrl !== peers[0]!.url) {
      throw new Error(`livegem tagged wrong peer: ${JSON.stringify(result.hits[0])}`);
    }

    if (result.errors.length !== 1) {
      throw new Error(`expected 1 error (offline peer), got ${JSON.stringify(result.errors)}`);
    }
    const err = result.errors[0]!;
    if (err.peerUrl !== peers[1]!.url) {
      throw new Error(`expected offline error on peer[1], got ${JSON.stringify(err)}`);
    }
    // Bun fetch failure on a closed port surfaces as "unreachable" (status=0
    // → reason=unreachable in fetchPeerManifest's classifier).
    if (err.reason !== "unreachable") {
      throw new Error(`expected reason=unreachable for offline peer, got ${err.reason}`);
    }
  },
};

export default scenario;
