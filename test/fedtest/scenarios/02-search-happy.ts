/**
 * Scenario 02 — federated search happy path (#655 Phase 2).
 *
 * Two peers each advertise a plugin via /api/plugin/list-manifest. A
 * search whose query matches both names returns one hit per peer, each
 * tagged with the right peerUrl and peerNode. Proves the fan-out + merge
 * path in `searchPeers()` actually reaches a live list-manifest endpoint
 * and reads the real response shape, not a hand-rolled mock.
 */

import type { Scenario } from "../scenario";
import { searchPeers } from "../../../src/commands/plugins/plugin/search-peers";

const scenario: Scenario = {
  name: "02-search-happy",
  backends: ["emulated"],
  peers: 2,
  async setUp(peers) {
    await peers[0]!.installPlugin({
      name: "alpha-tool",
      version: "1.0.0",
      summary: "alpha thing",
    });
    await peers[1]!.installPlugin({
      name: "beta-tool",
      version: "0.2.0",
      summary: "beta thing",
    });
  },
  async assert(peers) {
    const result = await searchPeers("tool", {
      peers: peers.map(p => ({ url: p.url, name: p.node })),
      noCache: true,
      perPeerMs: 2000,
      totalMs: 4000,
    });

    if (result.errors.length !== 0) {
      throw new Error(`expected zero errors, got ${JSON.stringify(result.errors)}`);
    }
    if (result.queried !== 2 || result.responded !== 2) {
      throw new Error(`expected queried=2 responded=2, got ${result.queried}/${result.responded}`);
    }
    if (result.hits.length !== 2) {
      throw new Error(`expected 2 hits, got ${result.hits.length}: ${JSON.stringify(result.hits)}`);
    }

    const byName = Object.fromEntries(result.hits.map(h => [h.name, h]));
    const alpha = byName["alpha-tool"];
    const beta = byName["beta-tool"];
    if (!alpha) throw new Error(`missing alpha-tool hit: ${JSON.stringify(result.hits)}`);
    if (!beta) throw new Error(`missing beta-tool hit: ${JSON.stringify(result.hits)}`);
    if (alpha.peerUrl !== peers[0]!.url || alpha.peerNode !== peers[0]!.node) {
      throw new Error(`alpha-tool tagged wrong peer: ${JSON.stringify(alpha)}`);
    }
    if (beta.peerUrl !== peers[1]!.url || beta.peerNode !== peers[1]!.node) {
      throw new Error(`beta-tool tagged wrong peer: ${JSON.stringify(beta)}`);
    }
  },
};

export default scenario;
