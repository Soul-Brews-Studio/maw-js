/**
 * Canary scenario — /info handshake round-trip (#655 Phase 1).
 *
 * For each peer, call probePeer(url) and assert the returned node
 * identity matches what the peer advertises. This is the same contract
 * that `scripts/test-docker-federation.sh` exercises today, just routed
 * through the BaseFederationBackend interface so it runs on either
 * backend without change.
 */

import type { Scenario } from "../scenario";
import { probePeer } from "../../../src/commands/plugins/peers/probe";

const scenario: Scenario = {
  name: "01-handshake",
  peers: 2,
  async assert(peers) {
    for (const peer of peers) {
      const result = await probePeer(peer.url);
      if (result.error) {
        throw new Error(
          `probe ${peer.url} failed: ${result.error.code} — ${result.error.message}`,
        );
      }
      if (result.node !== peer.node) {
        throw new Error(
          `probe ${peer.url} returned node=${result.node}, expected ${peer.node}`,
        );
      }
    }
  },
};

export default scenario;
