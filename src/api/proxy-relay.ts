// Proxy API — peer URL resolution and HTTP relay

import { loadConfig } from "../config";
import { signHeaders } from "../lib/federation-auth";
import { READONLY_METHODS } from "./proxy-trust";

export interface ProxyRelayDeps {
  loadConfig?: typeof loadConfig;
  signHeaders?: typeof signHeaders;
  fetch?: typeof fetch;
  now?: () => number;
}

// --- Peer URL resolution (same as wormhole — acceptable duplication) ----

export function resolveProxyPeerUrl(peer: string, config: any = loadConfig()): string | null {
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const match = namedPeers.find((p) => p.name === peer);
  if (match) return match.url;
  if (/^[\w.-]+:\d+$/.test(peer)) return `http://${peer}`;
  if (peer.startsWith("http://") || peer.startsWith("https://")) return peer;
  return null;
}

// --- Relay ---------------------------------------------------------------

export interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
}

export async function relayHttpToPeer(
  peerUrl: string,
  method: string,
  path: string,
  body: string | undefined,
  deps: ProxyRelayDeps = {},
): Promise<RelayResult> {
  const start = deps.now ? deps.now() : Date.now();
  const upper = method.toUpperCase();
  const outHeaders: Record<string, string> = {};

  // Sign outbound with existing HMAC mechanism
  const config = (deps.loadConfig ?? loadConfig)() as any;
  const token = config?.federationToken;
  if (token) {
    Object.assign(outHeaders, (deps.signHeaders ?? signHeaders)(token, upper, path));
  }

  // Only set Content-Type for methods that can carry a body
  if (body !== undefined && !READONLY_METHODS.has(upper)) {
    outHeaders["Content-Type"] = "application/json";
  }

  const response = await (deps.fetch ?? fetch)(`${peerUrl}${path}`, {
    method: upper,
    headers: outHeaders,
    body: READONLY_METHODS.has(upper) ? undefined : body,
  });

  // Collect a safe subset of response headers (don't leak Set-Cookie, etc.)
  const safeHeaders: Record<string, string> = {};
  const allowedResponseHeaders = ["content-type", "cache-control", "etag", "last-modified"];
  for (const h of allowedResponseHeaders) {
    const v = response.headers.get(h);
    if (v) safeHeaders[h] = v;
  }

  return {
    status: response.status,
    headers: safeHeaders,
    body: await response.text(),
    elapsedMs: (deps.now ? deps.now() : Date.now()) - start,
  };
}
