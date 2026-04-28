/**
 * Federation Auth — Elysia plugin (replaces Hono middleware from federation-auth.ts)
 *
 * HMAC-SHA256 request signing for peer-to-peer trust.
 * See federation-auth.ts for the crypto primitives (sign, verify, signHeaders).
 * This file provides only the Elysia onBeforeHandle hook.
 */

import { Elysia } from "elysia";
import { loadConfig, D } from "../config";
import { verify, isLoopback } from "./federation-auth";
import type { Server } from "bun";

const WINDOW_SEC = D.hmacWindowSeconds;

/** Protected paths — write/control operations, require auth from non-loopback clients */
const PROTECTED = new Set([
  "/send",
  "/pane-keys",
  "/talk",
  "/transport/send",
  "/triggers/fire",
  "/worktrees/cleanup",
]);

/** POST-only protected (GET is public for UI, POST needs auth) */
const PROTECTED_POST = new Set([
  "/feed",
]);

// Note: GET-only read endpoints (/sessions, /capture, /mirror)
// are intentionally public — the Office UI on LAN needs them.
// HMAC protects write operations from unauthenticated remote peers.

function isProtected(path: string, method: string): boolean {
  if (PROTECTED.has(path)) return true;
  if (PROTECTED_POST.has(path) && method === "POST") return true;
  // Protect plugin invocation — POST /plugins/:name is a control operation
  if (method === "POST" && path.startsWith("/plugins/")) return true;
  // Protect plugin tarball download (Task #1) — serves full artifact bytes.
  // list-manifest is intentionally public (lean metadata for discovery);
  // download is not — an anonymous GET would expose plugin artifacts to
  // anyone who can reach the node.
  if (method === "GET" && path.startsWith("/plugin/download/")) return true;
  return false;
}

// --- Bun server reference (set by server.ts after Bun.serve) ---
// SECURITY: We need the Bun server to call requestIP() on the raw
// TCP connection. This is the ONLY authoritative source for client IP.
// Headers (X-Forwarded-For, X-Real-IP) are attacker-controlled and
// MUST NOT influence auth decisions. See #191.
let _bunServer: Server | null = null;

/** Store the Bun server reference so the auth plugin can call requestIP().
 *  Called once from server.ts after Bun.serve(). */
export function setBunServer(server: Server): void {
  _bunServer = server;
}

/** Federation auth — Elysia plugin with onBeforeHandle HMAC verification */
export const federationAuth = new Elysia({ name: "federation-auth" })
  .onBeforeHandle(({ request, set }) => {
    const config = loadConfig();
    const token = config.federationToken;

    // No token configured → auth disabled (backwards compat)
    if (!token) return;

    const url = new URL(request.url);
    // Strip /api prefix to match against PROTECTED set
    const path = url.pathname.replace(/^\/api/, "");

    // Not a protected path → pass
    if (!isProtected(path, request.method)) return;

    // Check if loopback (local CLI / browser on same machine).
    // SECURITY: only the TCP source address is authoritative — X-Forwarded-For
    // and X-Real-IP are attacker-controlled headers and MUST NOT influence
    // auth decisions. See #191 for the empirically-verified RCE vector
    // (Test 3 on mba: POST /api/send to a non-loopback interface with
    // `X-Forwarded-For: 127.0.0.1` bypassed HMAC entirely).
    //
    // NOTE: this fix closes Path A (header spoof from external IP) and
    // Path C (forwarder + spoof combo), but DOES NOT close Path B (a local
    // process — cloudflared, nginx, sidecar — forwarding to localhost makes
    // the TCP source legitimately 127.0.0.1). The full fix (Option C in #191)
    // is to remove this bypass entirely and have the local CLI sign all
    // requests; this lands in a follow-up PR.
    const clientIp = _bunServer?.requestIP?.(request)?.address;

    if (isLoopback(clientIp)) return;

    // Check for HMAC signature
    const sig = request.headers.get("x-maw-signature");
    const ts = request.headers.get("x-maw-timestamp");

    if (!sig || !ts) {
      set.status = 401;
      return { error: "federation auth required", reason: "missing_signature" };
    }

    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp)) {
      set.status = 401;
      return { error: "federation auth failed", reason: "invalid_timestamp" };
    }

    // Verify against the full /api/... path (same as what peers sign)
    if (!verify(token, request.method, url.pathname, timestamp, sig)) {
      const now = Math.floor(Date.now() / 1000);
      const delta = Math.abs(now - timestamp);
      const reason = delta > WINDOW_SEC ? "timestamp_expired" : "signature_invalid";
      console.warn(`[auth] rejected ${request.method} ${url.pathname} from ${clientIp}: ${reason} (delta=${delta}s)`);
      set.status = 401;
      return { error: "federation auth failed", reason, ...(delta > WINDOW_SEC ? { delta } : {}) };
    }

    // Auth passed — continue to handler
  });
