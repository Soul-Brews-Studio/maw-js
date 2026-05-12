// Proxy API — HTTP method classification and path/peer allowlists

import { loadConfig } from "../config";

// --- HTTP method classification ------------------------------------------

const READONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export { READONLY_METHODS, MUTATING_METHODS };

export function isReadOnlyMethod(method: string): boolean {
  return READONLY_METHODS.has(method.toUpperCase());
}

export function isKnownMethod(method: string): boolean {
  const m = method.toUpperCase();
  return READONLY_METHODS.has(m) || MUTATING_METHODS.has(m);
}

// --- Path allowlist ------------------------------------------------------

/**
 * Which peer paths are OK to proxy? These are the v1 REST endpoints that
 * maw-ui callers actually read. Anything else is rejected to reduce the
 * attack surface for an anonymous proxy endpoint.
 *
 * Iteration 6+ may relax this to a per-peer config if real-world usage
 * demands broader coverage — but the default should stay tight.
 */
const PROXY_PATH_ALLOWLIST: string[] = [
  "/api/config",
  "/api/fleet-config",
  "/api/feed",
  "/api/plugins",
  "/api/federation/status",
  "/api/sessions",
  "/api/worktrees",
  "/api/teams",
  "/api/ping",
];

export function isPathProxyable(path: string): boolean {
  // Exact match only (query strings stripped). NO prefix matching — prefix
  // matching would allow "/api/worktrees/cleanup" to smuggle through via
  // the "/api/worktrees" entry even though /worktrees/cleanup is a
  // PROTECTED write endpoint in src/lib/federation-auth.ts:19.
  // Caught in iteration-6 test: "denied path: /api/worktrees/cleanup".
  const pathname = path.split("?")[0];
  return PROXY_PATH_ALLOWLIST.includes(pathname);
}

// --- Shell peer check (NOT shared with wormhole) -------------------------

export function isProxyShellPeerAllowed(originHost: string): boolean {
  if (originHost.startsWith("anon-")) return false;
  const config = loadConfig() as unknown as Record<string, unknown>;
  const proxy = config?.proxy as unknown as Record<string, unknown>;
  const allowed: string[] = (proxy?.shellPeers as unknown[]) ?? [];
  return allowed.includes(originHost);
}
