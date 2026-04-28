/**
 * federation-fetch.ts — fetchPeerIdentities async I/O.
 */

import type { PeerConfig } from "../../config";
import { cfgTimeout } from "../../config";
import { curlFetch } from "../../sdk";
import type { PeerIdentity } from "./federation-identity";

/**
 * Hit every namedPeer's /api/identity in parallel.
 * Always returns one PeerIdentity per peer — unreachable peers are marked,
 * not dropped, so the CLI can surface them.
 */
export async function fetchPeerIdentities(
  peers: PeerConfig[],
  timeout?: number,
): Promise<PeerIdentity[]> {
  const t = timeout ?? cfgTimeout("http");
  return Promise.all(
    peers.map(async (p): Promise<PeerIdentity> => {
      try {
        const res = await curlFetch(`${p.url}/api/identity`, { timeout: t, from: "auto" /* #804 Step 4 SIGN — v3-sign cross-node /api/identity health */ });
        if (!res.ok || !res.data) {
          return {
            peerName: p.name,
            url: p.url,
            node: "",
            agents: [],
            reachable: false,
            error: `http ${res.status ?? "?"}`,
          };
        }
        const data = res.data as { node?: unknown; agents?: unknown };
        if (typeof data.node !== "string" || !Array.isArray(data.agents)) {
          return {
            peerName: p.name,
            url: p.url,
            node: "",
            agents: [],
            reachable: false,
            error: "invalid identity shape",
          };
        }
        const agents = data.agents.filter((a): a is string => typeof a === "string");
        return { peerName: p.name, url: p.url, node: data.node, agents, reachable: true };
      } catch (e: any) {
        return {
          peerName: p.name,
          url: p.url,
          node: "",
          agents: [],
          reachable: false,
          error: String(e?.message || e).split("\n")[0],
        };
      }
    }),
  );
}
