/**
 * Scenario 05 — @peer install end-to-end via emulated backend (#655 Phase 2).
 *
 * Proves the `<name>@<peer>` install chain holds together against a live
 * local HTTP listener:
 *
 *   searchPeers /api/plugin/list-manifest  (resolvePeerInstall)
 *     → synthesize downloadUrl from peerUrl + plugin name
 *     → fetch /api/plugin/download/:name
 *     → receive real tarball bytes (200, Content-Type gzip)
 *
 * Parallel proof to the mesh-child dogfood: if the cross-oracle install
 * flow regresses — say a future refactor changes the download URL shape
 * or the list-manifest schema — this scenario fails on emulated without
 * needing a docker stack.
 *
 * The plugins.lock enforcement path is intentionally out of scope here.
 * That lives in installFromTarball() and is a production trust boundary
 * (#487) exercised by dedicated lockfile tests — not federation harness
 * scope.
 */

import type { Scenario } from "../scenario";
import { resolvePeerInstall } from "../../../src/commands/plugins/plugin/install-peer-resolver";

const FAKE_TARBALL = new TextEncoder().encode("FAKE_TGZ_BYTES_FOR_FEDTEST_05");
const FAKE_SHA = "sha256:feedbeef";

const scenario: Scenario = {
  name: "05-install-at-peer",
  backends: ["emulated"],
  peers: 2,
  async setUp(peers) {
    await peers[0]!.installPlugin({
      name: "ping",
      version: "1.0.0",
      summary: "pingbeacon",
      author: "fedtest",
      tarball: FAKE_TARBALL,
      sha256: FAKE_SHA,
    });
    // peer[1] is the distractor — it must NOT resolve as the install source.
    await peers[1]!.installPlugin({ name: "other", version: "0.1.0" });
  },
  async assert(peers) {
    const peerName = peers[0]!.node;

    // Step 1: resolve — hits list-manifest on every peer, picks peer 0.
    const resolved = await resolvePeerInstall("ping", peerName, {
      searchOpts: {
        peers: peers.map(p => ({ url: p.url, name: p.node })),
        noCache: true,
        perPeerMs: 2000,
        totalMs: 4000,
      },
    });

    if (resolved.version !== "1.0.0") {
      throw new Error(`expected version=1.0.0, got ${resolved.version}`);
    }
    if (resolved.peerUrl !== peers[0]!.url) {
      throw new Error(`expected peerUrl=${peers[0]!.url}, got ${resolved.peerUrl}`);
    }
    const expectedDownload = `${peers[0]!.url}/api/plugin/download/ping`;
    if (resolved.downloadUrl !== expectedDownload) {
      throw new Error(`expected downloadUrl=${expectedDownload}, got ${resolved.downloadUrl}`);
    }
    if (resolved.peerSha256 !== FAKE_SHA) {
      throw new Error(`expected peerSha256=${FAKE_SHA}, got ${resolved.peerSha256}`);
    }
    if (resolved.peerNode !== peers[0]!.node) {
      throw new Error(`expected peerNode=${peers[0]!.node}, got ${resolved.peerNode}`);
    }

    // Step 2: fetch the synthesized downloadUrl — the last link in the chain.
    const res = await fetch(resolved.downloadUrl);
    if (!res.ok) {
      throw new Error(`download fetch failed: status=${res.status}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("gzip")) {
      throw new Error(`expected Content-Type gzip, got ${ctype}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== FAKE_TARBALL.length) {
      throw new Error(`tarball length mismatch: expected ${FAKE_TARBALL.length}, got ${bytes.length}`);
    }
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== FAKE_TARBALL[i]) {
        throw new Error(`tarball byte mismatch at index ${i}`);
      }
    }
  },
};

export default scenario;
