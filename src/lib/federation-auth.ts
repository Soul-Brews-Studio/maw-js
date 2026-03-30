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

    // No token configured → auth disabled (backwards compat)
    if (!token) return next();

    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/api/, "/api"); // normalize

    // Not a protected path → pass
    if (!isProtected(path, c.req.method)) return next();

    // Check if loopback (local CLI / browser on same machine)
    const clientIp = c.req.header("x-forwarded-for")?.split(",")[0].trim()
      || c.req.header("x-real-ip")
      || (c.env as any)?.server?.requestIP?.(c.req.raw)?.address;

    if (isLoopback(clientIp)) return next();

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
