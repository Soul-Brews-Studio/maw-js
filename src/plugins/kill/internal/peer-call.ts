/**
 * Cross-node forwarding of `maw kill --peer <alias>` to a peer's /api/kill.
 *
 * Thin wrapper over `curlFetch` so the network call can be stubbed in
 * tests without dragging in the full maw-js/sdk module graph. The
 * `from: "auto"` option enables federation signing when peer-identity
 * keys are configured (see ADR docs/federation/0001-peer-identity.md).
 *
 * Mirrors plugins/wake/internal/peer-call.ts. Endpoint is `POST /api/kill`
 * — declared in this plugin's own plugin.json and served by the maw-js
 * plugin registry router on the peer node. Body shape matches the API
 * branch of plugins/kill/index.ts: `{ target: string, pane?: number }`.
 */

export interface PeerCallResult {
  ok: boolean;
  status?: number;
  data?: any;
}

export async function callPeerKill(peerUrl: string, body: Record<string, unknown>): Promise<PeerCallResult> {
  const { curlFetch } = await import("maw-js/sdk");
  return await curlFetch(`${peerUrl}/api/kill`, {
    method: "POST",
    body: JSON.stringify(body),
    from: "auto",
  });
}
