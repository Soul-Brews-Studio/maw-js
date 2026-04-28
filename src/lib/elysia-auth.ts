/**
 * Federation Auth — Elysia plugin (replaces Hono middleware from federation-auth.ts)
 *
 * HMAC-SHA256 request signing for peer-to-peer trust.
 * See federation-auth.ts for the crypto primitives (sign, verify, signHeaders).
 * This file provides only the Elysia onBeforeHandle hook.
 *
 * #804 Step 4: a second plugin (`fromSigningAuth`) layers per-peer continuity
 * (ed25519 signature with the sender's `from:` identity) on top of the
 * fleet-membership HMAC. The two layers are independent — see ADR
 * docs/federation/0001-peer-identity.md.
 */

import { Elysia } from "elysia";
import { loadConfig, D } from "../config";
import { verify, isLoopback, verifyRequest, isRefuseDecision, type FromVerifyDecision } from "./federation-auth";
import { loadPeers } from "../commands/plugins/peers/store";
import type { Server } from "bun";

const WINDOW_SEC = D.hmacWindowSeconds;

/** Protected paths — write/control operations, require auth from non-loopback clients */
const PROTECTED = new Set([
  "/send",
  "/pane-keys",
  "/wake",            // #798 — clones repos, spawns tmux + agent processes
  "/sleep",           // #798 — kills tmux sessions
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

export function isProtected(path: string, method: string): boolean {
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

// --- #804 Step 4 — per-peer "from:" verification (O6 enforcement) ---
//
// This plugin runs AFTER the HMAC plugin. By the time we get here, fleet
// membership is already proven. We now ask: "is this the peer we last spoke
// with?" Refuse on any O6 row that says refuse.
//
// Routes covered: same PROTECTED set as HMAC. Loopback bypass mirrors HMAC
// (local CLI signs HMAC but not from-sig — yet — so we don't gate on it).
// federationToken absent → from-sig also disabled (single-node mode).

/**
 * Look up the cached ed25519 pubkey (hex) for a peer claiming `<oracle>:<node>`.
 *
 * Strategy: scan peers.json, return the pubkey of the first entry whose
 * `node` matches the `<node>` half of `from`. Single-peer-per-node is the
 * common case (and the doctor warns on collisions); on collisions we just
 * pick the first match deterministically. Returns undefined if no match
 * or no cached pubkey.
 *
 * The `<oracle>` half is currently informational — the canonical address
 * grammar in ADR 0001 is `<oracle>:<node>`, but peers.json is keyed by
 * alias (operator-chosen) and only `node` is enforced. Tightening to a
 * full <oracle>:<node> match is a follow-up once the peers store learns
 * the oracle name (today it has node + nickname only).
 */
export function lookupCachedPubkey(from: string): string | undefined {
  const colon = from.indexOf(":");
  if (colon < 0) return undefined;
  const node = from.slice(colon + 1).trim();
  if (!node) return undefined;
  const peers = loadPeers().peers;
  for (const alias of Object.keys(peers)) {
    const p = peers[alias];
    if (p?.node === node && p?.pubkey) return p.pubkey;
  }
  return undefined;
}

/** Federation auth — from: + signature plugin (#804 Step 4). */
export const fromSigningAuth = new Elysia({ name: "from-signing-auth" })
  .onBeforeHandle(async ({ request, set }) => {
    const config = loadConfig();
    // Backwards compat: no fleet token configured → single-node, no peer
    // continuity to enforce. Same gate as HMAC.
    if (!config.federationToken) return;

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    if (!isProtected(path, request.method)) return;

    // Loopback: same exception as HMAC. Local CLI does not yet from-sign.
    const clientIp = _bunServer?.requestIP?.(request)?.address;
    if (isLoopback(clientIp)) return;

    // Read body once (clone). We need the bytes for the body-hash binding.
    let body: Uint8Array | undefined;
    try {
      const clone = request.clone();
      body = new Uint8Array(await clone.arrayBuffer());
    } catch (err) {
      console.warn(`[from-auth] body read failed for ${request.method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      set.status = 401;
      return { error: "from-signing failed", reason: "body_read_failed" };
    }

    const decision: FromVerifyDecision = verifyRequest({
      method: request.method,
      // Sign over the full /api/<path>; sender signs the same.
      path: url.pathname,
      headers: request.headers,
      body,
      lookupPubkey: lookupCachedPubkey,
    });

    if (isRefuseDecision(decision)) {
      const ipPart = clientIp ?? "?";
      console.warn(`[from-auth] rejected ${request.method} ${url.pathname} from ${ipPart}: ${decision.kind} (${decision.reason})`);
      set.status = 401;
      const body: Record<string, unknown> = {
        error: "from-signing failed",
        reason: decision.reason,
        kind: decision.kind,
      };
      if ("from" in decision && decision.from) body.from = decision.from;
      if ("delta" in decision) body.delta = (decision as { delta: number }).delta;
      return body;
    }

    // Accept paths: log the TOFU-record case so operators see legacy peers
    // bootstrapping. accept-legacy is the silent (pre-Step-4) path.
    if (decision.kind === "accept-tofu-record") {
      console.warn(`[from-auth] accepted signed request from unknown peer ${decision.from} (no cached pubkey to verify against — alpha behavior; will harden at v27)`);
    }
    // accept-verified is the steady-state happy path; no log spam.
  });

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

    // #804 Step 4: when the request carries `x-maw-from`, the from-signing
    // layer owns the `x-maw-signature` slot and is verified by
    // `fromSigningAuth` (mounted alongside this plugin). Defer to it — the
    // fleet HMAC layer would otherwise reject the from-sig as a malformed
    // HMAC since it's keyed on `peerKey`, not `federationToken`.
    if (request.headers.get("x-maw-from")) return;

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
