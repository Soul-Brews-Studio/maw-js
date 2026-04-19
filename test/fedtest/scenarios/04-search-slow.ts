/**
 * Scenario 04 — slow peer exceeds total budget → reason=timeout (#655 Phase 2).
 *
 * A single peer delays every response past the total search budget. The
 * Promise.race inside `searchPeers()` fires the synthesized timeout
 * outcome, which classifies the peer with reason="timeout" — distinct
 * from "unreachable" so operators can diagnose hung peers vs. hard-down
 * peers. Contract: slow peers never corrupt the aggregate; caller always
 * gets a clean result within `totalMs + epsilon`.
 */

import type { Scenario } from "../scenario";
import { searchPeers } from "../../../src/commands/plugins/plugin/search-peers";

const SLOW_MS = 600;
const TOTAL_MS = 150;

const scenario: Scenario = {
  name: "04-search-slow",
  backends: ["emulated"],
  peers: 1,
  async setUp(peers) {
    await peers[0]!.installPlugin({ name: "slowgem", version: "1.0.0" });
    await peers[0]!.setSlow(SLOW_MS);
  },
  async assert(peers) {
    const start = Date.now();
    const result = await searchPeers("slowgem", {
      peers: peers.map(p => ({ url: p.url, name: p.node })),
      noCache: true,
      perPeerMs: 5000, // per-peer budget deliberately generous — we want the TOTAL budget to fire
      totalMs: TOTAL_MS,
    });
    const elapsed = Date.now() - start;

    // Result should land close to totalMs, not near SLOW_MS — proves the race fired.
    if (elapsed >= SLOW_MS) {
      throw new Error(
        `expected search to return near totalMs=${TOTAL_MS}ms, but took ${elapsed}ms — total-budget race did not fire`,
      );
    }

    if (result.responded !== 0) {
      throw new Error(`expected responded=0 on total timeout, got ${result.responded}`);
    }
    if (result.hits.length !== 0) {
      throw new Error(`expected zero hits on total timeout, got ${JSON.stringify(result.hits)}`);
    }
    if (result.errors.length !== 1) {
      throw new Error(`expected 1 error (slow peer), got ${JSON.stringify(result.errors)}`);
    }
    const err = result.errors[0]!;
    if (err.reason !== "timeout") {
      throw new Error(`expected reason=timeout, got reason=${err.reason} detail=${err.detail}`);
    }
    if (err.peerUrl !== peers[0]!.url) {
      throw new Error(`timeout tagged wrong peer: ${JSON.stringify(err)}`);
    }
  },
  async teardown(peers) {
    // Clear the slow override so the Bun.serve fetch handler doesn't keep
    // sleeping while backend.teardown() tries to stop it.
    await peers[0]!.setSlow(null);
  },
};

export default scenario;
