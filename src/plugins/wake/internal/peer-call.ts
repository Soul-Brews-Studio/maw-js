/**
 * Cross-node forwarding of `maw wake --peer <alias>` to a peer's /api/wake.
 *
 * Thin wrapper over `curlFetch` so the network call can be stubbed in
 * tests without dragging in the full maw-js/sdk module graph. The
 * `from: "auto"` option enables federation signing when peer-identity
 * keys are configured (see ADR docs/federation/0001-peer-identity.md).
 */

export interface PeerCallResult {
  ok: boolean;
  status?: number;
  data?: any;
}

export async function callPeerWake(peerUrl: string, body: Record<string, unknown>): Promise<PeerCallResult> {
  const { curlFetch } = await import("maw-js/sdk");
  return await curlFetch(`${peerUrl}/api/wake`, {
    method: "POST",
    body: JSON.stringify(body),
    from: "auto",
  });
}
