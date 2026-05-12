/**
 * Scout auto-pairing — HTTP handshake after Scout/Hello discovery.
 *
 * After GreaterZid selects the initiator, it POSTs to the peer's
 * /api/pair/auto endpoint. Both sides persist via cmdAdd().
 */

import { cmdAdd } from "../lib/peers/impl";
import type { DiscoveredPeer } from "./scout-state";

export interface AutoPairRequest {
  node: string;
  oracle: string;
  url: string;
  zid: string;
  capabilities: string[];
}

export interface AutoPairResponse {
  ok: boolean;
  node?: string;
  oracle?: string;
  url?: string;
  error?: string;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

export async function initiatePair(
  peer: DiscoveredPeer,
  localNode: string,
  localOracle: string,
  localPort: number,
): Promise<OperationResult> {
  const locator = peer.locators[0];
  if (!locator) return { ok: false, error: "no_locator" };

  const body: AutoPairRequest = {
    node: localNode,
    oracle: localOracle,
    url: `http://${localNode}:${localPort}`,
    zid: peer.zid,
    capabilities: ["pair", "feed", "send"],
  };

  try {
    const res = await fetch(`${locator}/api/pair/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${text}` };
    }

    const data = (await res.json()) as AutoPairResponse;
    if (!data.ok) return { ok: false, error: data.error ?? "rejected" };

    await cmdAdd({
      alias: peer.node,
      url: locator,
      node: peer.node,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
