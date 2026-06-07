/**
 * Scout auto-pairing — HTTP handshake after Scout/Hello discovery.
 *
 * After GreaterZid selects the initiator, it POSTs to the peer's
 * /api/pair/auto endpoint. Both sides persist via cmdAdd().
 */

import { cmdAdd } from "../lib/peers/impl";
import { getPeerKey } from "../lib/peer-key";
import { loadConfig } from "../config";
import type { DiscoveredPeer } from "./scout-state";
import { verifyAutoPairProof } from "./scout-pair-proof";

export interface AutoPairRequest {
  node: string;
  oracle: string;
  url: string;
  zid: string;
  pubkey?: string;
  capabilities: string[];
}

export interface AutoPairResponse {
  ok: boolean;
  node?: string;
  oracle?: string;
  url?: string;
  pubkey?: string;
  proof?: string;
  oneWay?: boolean;
  error?: string;
}

export interface InitiatePairDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cmdAddFn?: typeof cmdAdd;
  getPeerKeyFn?: typeof getPeerKey;
  loadConfigFn?: typeof loadConfig;
}

const AUTO_PAIR_PATH = "/api/pair/auto";
const PAIR_POST_TIMEOUT_MS = 2_000;
const PAIR_RETRY_DELAYS_MS = [0, 200, 800] as const;

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function initiatePair(
  peer: DiscoveredPeer,
  localNode: string,
  localOracle: string,
  localPort: number,
  deps: InitiatePairDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  const locator = peer.locators[0];
  if (!locator) return { ok: false, error: "no_locator" };
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const addPeer = deps.cmdAddFn ?? cmdAdd;
  const peerKey = (deps.getPeerKeyFn ?? getPeerKey)();
  const config = (deps.loadConfigFn ?? loadConfig)();

  const body: AutoPairRequest = {
    node: localNode,
    oracle: localOracle,
    url: `http://${localNode}:${localPort}`,
    zid: peer.zid,
    pubkey: peerKey,
    capabilities: ["pair", "feed", "send"],
  };
  const bodyJson = JSON.stringify(body);

  let lastError = "pair_failed";
  for (const [attempt, delayMs] of PAIR_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) await sleep(delayMs);

    try {
      const res = await fetchFn(new URL(AUTO_PAIR_PATH, locator), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson,
        signal: AbortSignal.timeout(PAIR_POST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastError = `http_${res.status}: ${text}`;
        if (res.status >= 400 && res.status < 500) return { ok: false, error: lastError };
        continue;
      }

      const data = (await res.json()) as AutoPairResponse;
      if (!data.ok) {
        lastError = data.error ?? "rejected";
        return { ok: false, error: lastError };
      }

      if (data.proof && data.pubkey && config.federationToken) {
        const valid = verifyAutoPairProof({
          node: data.node ?? peer.node,
          oracle: data.oracle ?? "mawjs",
          url: data.url ?? locator,
          pubkey: data.pubkey,
        }, config.federationToken, data.proof);
        if (!valid) return { ok: false, error: "bad_proof" };
      } else if (data.proof && (!data.pubkey || !config.federationToken)) {
        return { ok: false, error: "bad_proof_payload" };
      }

      const addResult = await addPeer({
        alias: peer.node,
        url: locator,
        node: peer.node,
        pubkey: data.pubkey,
        identity: data.node ? { oracle: data.oracle ?? "mawjs", node: data.node } : undefined,
        markSymmetricCheck: true,
        oneWay: data.oneWay,
      });
      if (addResult.pubkeyMismatch) return { ok: false, error: addResult.pubkeyMismatch.message };

      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === PAIR_RETRY_DELAYS_MS.length - 1) break;
    }
  }

  return { ok: false, error: lastError };
}
