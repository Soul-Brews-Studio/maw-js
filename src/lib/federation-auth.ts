/**
 * Federation Auth — HMAC-SHA256 request signing for peer-to-peer trust.
 *
 * Design:
 *   - Each node shares a `federationToken` (config field, min 16 chars)
 *   - Outgoing HTTP calls sign: HMAC-SHA256(token, "METHOD:PATH:TIMESTAMP")
 *   - Incoming requests verify signature within ±5 min window
 *   - No token configured → all requests pass (backwards compat)
 *   - Loopback requests always pass (local CLI / browser)
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { loadConfig } from "../config";

const WINDOW_SEC = 300; // ±5 minutes

/** Protected paths — write/control operations, require auth from non-loopback clients */
const PROTECTED = new Set([
  "/api/send",
  "/api/talk",
  "/api/transport/send",
  "/api/triggers/fire",
  "/api/worktrees/cleanup",
]);

/** POST-only protected (GET is public for UI, POST needs auth) */
const PROTECTED_POST = new Set([
  "/api/feed",
]);

// Note: GET-only read endpoints (/api/sessions, /api/capture, /api/mirror)
// are intentionally public — the Office UI on LAN needs them.
// HMAC protects write operations from unauthenticated remote peers.

// --- Core crypto ---

export function sign(token: string, method: string, path: string, timestamp: number): string {
  const payload = `${method}:${path}:${timestamp}`;
  return createHmac("sha256", token).update(payload).digest("hex");
}

export function verify(token: string, method: string, path: string, timestamp: number, signature: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.abs(now - timestamp);
  if (delta > WINDOW_SEC) return false;

  const expected = sign(token, method, path, timestamp);
  if (expected.length !== signature.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// --- Helpers ---

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "localhost"
    || address.startsWith("127.");
}

/** Produce auth headers for outgoing federation HTTP calls */
export function signHeaders(token: string, method: string, path: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "X-Maw-Timestamp": String(ts),
    "X-Maw-Signature": sign(token, method, path, ts),
  };
}

// --- Hono middleware ---

function isProtected(path: string, method: string): boolean {
  if (PROTECTED.has(path)) return true;
  if (PROTECTED_POST.has(path) && method === "POST") return true;
  return false;
}

/** Federation auth middleware — smart per-path enforcement */
export function federationAuth(): MiddlewareHandler {
  return async (c, next) => {
    const config = loadConfig();
    const token = config.federationToken;
    const hasPeers = (config.peers?.length ?? 0) > 0 || (config.namedPeers?.length ?? 0) > 0;
    const allowPeersWithoutToken = (config as unknown as { allowPeersWithoutToken?: boolean }).allowPeersWithoutToken === true;

    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/api/, "/api"); // normalize

    // Not a protected path → pass (reads remain public so the Office UI works)
    if (!isProtected(path, c.req.method)) return next();

    // Loopback (local CLI / browser on same machine) still trusted.
    // SECURITY: only the TCP source address is authoritative (see #191).
    const clientIp = (c.env as any)?.server?.requestIP?.(c.req.raw)?.address;
    if (isLoopback(clientIp)) return next();

    // Peers-require-token invariant (Bloom federation-audit iteration 2):
    // If peers are configured, the server binds to 0.0.0.0 (see core/server.ts)
    // and is network-reachable. No federationToken in that posture is
    // default-insecure-open — refuse protected writes from non-loopback
    // callers. Operators who truly need the legacy behavior must opt in
    // explicitly with `allowPeersWithoutToken: true`.
    if (!token && hasPeers && !allowPeersWithoutToken) {
      return c.json({ error: "federation auth required", reason: "federation_token_required" }, 401);
    }

    // No token configured AND no peers → local-only single-node mode.
    // The server binds to 127.0.0.1 in this posture, so reaching this
    // middleware from a non-loopback source is already unexpected; but
    // preserve legacy pass-through so fresh installs work unchanged.
    if (!token) return next();

    // NOTE on Path B (from issue #191): a local process (cloudflared, nginx,
    // sidecar) forwarding to localhost makes the TCP source legitimately
    // 127.0.0.1, which `isLoopback` above will trust. This is a separate
    // follow-up (Option C in #191 — have the local CLI sign all requests).
    // X-Forwarded-For / X-Real-IP are never consulted; only the TCP source
    // address is authoritative for loopback detection.

    // Check for HMAC signature
    const sig = c.req.header("x-maw-signature");
    const ts = c.req.header("x-maw-timestamp");

    if (!sig || !ts) {
      return c.json({ error: "federation auth required", reason: "missing_signature" }, 401);
    }

    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp)) {
      return c.json({ error: "federation auth failed", reason: "invalid_timestamp" }, 401);
    }

    if (!verify(token, c.req.method, path, timestamp, sig)) {
      const now = Math.floor(Date.now() / 1000);
      const delta = Math.abs(now - timestamp);
      const reason = delta > WINDOW_SEC ? "timestamp_expired" : "signature_invalid";
      console.warn(`[auth] rejected ${c.req.method} ${path} from ${clientIp}: ${reason} (delta=${delta}s)`);
      return c.json({ error: "federation auth failed", reason, ...(delta > WINDOW_SEC ? { delta } : {}) }, 401);
    }

    return next();
  };
}
