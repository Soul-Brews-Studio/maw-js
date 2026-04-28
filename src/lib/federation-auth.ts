/**
 * Federation Auth — HMAC-SHA256 request signing for peer-to-peer trust.
 *
 * Design:
 *   - Each node shares a `federationToken` (config field, min 16 chars)
 *   - Outgoing HTTP calls sign: HMAC-SHA256(token, "METHOD:PATH:TIMESTAMP[:BODY_SHA256]")
 *   - Incoming requests verify signature within ±5 min window
 *   - No token configured → all requests pass (backwards compat)
 *   - Loopback requests always pass (local CLI / browser)
 *
 * Signature versions:
 *   - v1 (legacy): payload is METHOD:PATH:TIMESTAMP. Body is NOT signed — a
 *     captured v1 signature allows arbitrary body substitution within the
 *     5-min window (this is the attack D#2 closes).
 *   - v2 (preferred): payload is METHOD:PATH:TIMESTAMP:BODY_SHA256. Body hash
 *     binds the signature to the exact bytes sent. Body-swap replay is 401.
 *   - Version is signaled via `X-Maw-Auth-Version: v2` header. Absent header
 *     = v1 (for outbound: signHeaders without body; for inbound: legacy peer).
 *
 * v3 — from: + per-peer pubkey signing (Step 4 SIGN of #804):
 *   - ADDITIVE on top of v1/v2. Outgoing requests carry the v2 token-signed
 *     headers AND, when the sender knows its `<oracle>:<node>` identity,
 *     a second signature keyed by the per-peer key (src/lib/peer-key.ts).
 *     The verifier (Step 4 VERIFY) reads `X-Maw-From` to look the sender
 *     up in its TOFU pubkey cache (Step 2) and authenticates the v3 sig
 *     against the pinned pubkey. v1/v2 remains for non-fleet peers.
 *   - Headers: `X-Maw-From`, `X-Maw-Signature-V3`, `X-Maw-Auth-Version: v3`.
 *     Reuses the v2 `X-Maw-Timestamp` (numeric seconds) and the v2
 *     `WINDOW_SEC` ±5 min skew window. No new clock primitive.
 *   - Payload: `METHOD:PATH:TIMESTAMP:BODY_SHA256:FROM` — extends the v2
 *     colon-shape with the `<oracle>:<node>` from-address appended. Body
 *     hash is mandatory in v3 (no v1 body-unsigned escape).
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { loadConfig } from "../config";

const WINDOW_SEC = 300; // ±5 minutes
const FROM_SIG_WINDOW_SEC = 300; // ±5 minutes for #804 Step 4 from-signing

/** Stable body-hash for the signed payload. Empty body → empty string. */
export function hashBody(body: string | Uint8Array | undefined | null): string {
  if (body == null || (typeof body === "string" && body.length === 0)) return "";
  if (body instanceof Uint8Array && body.length === 0) return "";
  return createHash("sha256").update(body as string | Buffer).digest("hex");
}

/** Protected paths — write/control operations, require auth from non-loopback clients */
const PROTECTED = new Set([
  "/api/send",
  "/api/pane-keys",
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

/**
 * Sign a request. When `bodyHash` is provided, produces a v2 signature that
 * binds the signature to the body bytes. When omitted or empty, produces a
 * v1 signature (legacy, body-unsigned).
 */
export function sign(token: string, method: string, path: string, timestamp: number, bodyHash = ""): string {
  const payload = bodyHash
    ? `${method}:${path}:${timestamp}:${bodyHash}`
    : `${method}:${path}:${timestamp}`;
  return createHmac("sha256", token).update(payload).digest("hex");
}

/**
 * Verify a signature. `bodyHash` must match what was signed:
 *   - omitted/empty → verifies v1 (legacy)
 *   - provided     → verifies v2 (body-bound)
 * The caller is responsible for passing the right value based on the
 * `X-Maw-Auth-Version` header on the incoming request.
 */
export function verify(token: string, method: string, path: string, timestamp: number, signature: string, bodyHash = ""): boolean {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.abs(now - timestamp);
  if (delta > WINDOW_SEC) return false;

  const expected = sign(token, method, path, timestamp, bodyHash);
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

/**
 * Produce auth headers for outgoing federation HTTP calls.
 *
 * When `body` is provided (and non-empty), emits v2 signature + the
 * `X-Maw-Auth-Version: v2` header so the peer knows to re-hash the body
 * and verify accordingly. When omitted, produces v1 for backward compat
 * (but callers SHOULD pass the body whenever possible — body-swap replay
 * is a real attack path otherwise).
 */
export function signHeaders(
  token: string,
  method: string,
  path: string,
  body?: string | Uint8Array,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const bh = body != null ? hashBody(body) : "";
  const headers: Record<string, string> = {
    "X-Maw-Timestamp": String(ts),
    "X-Maw-Signature": sign(token, method, path, ts, bh),
  };
  if (bh) headers["X-Maw-Auth-Version"] = "v2";
  return headers;
}

// --- v3 from-signing (#804 Step 4 SIGN) ---

/** Default oracle name when `config.oracle` is not set (single-tenant fallback). */
export const DEFAULT_ORACLE = "mawjs";

/**
 * Compute the v3 HMAC over the canonical payload — split out so callers (and
 * the verifier in Step 4 VERIFY) can reproduce the exact signature for the
 * same inputs. Payload extends v2 with the from-address appended:
 *
 *   `METHOD:PATH:TIMESTAMP:BODY_SHA256:FROM`
 *
 * Body hash is mandatory in v3 (no body → empty-string slot, exactly like v2).
 * Method is uppercased; path is `URL.pathname` (no query/fragment).
 */
export function signRequestV3(opts: {
  peerKey: string;
  fromAddress: string;
  method: string;
  path: string;
  timestamp: number;
  body?: string | Uint8Array;
}): { signature: string; bodyHash: string } {
  if (!opts.peerKey) throw new Error("signRequestV3: peerKey is required");
  if (!opts.fromAddress) throw new Error("signRequestV3: fromAddress is required (<oracle>:<node>)");
  const method = (opts.method || "GET").toUpperCase();
  const bodyHash = opts.body != null ? hashBody(opts.body) : "";
  const payload = `${method}:${opts.path}:${opts.timestamp}:${bodyHash}:${opts.fromAddress}`;
  const signature = createHmac("sha256", opts.peerKey).update(payload).digest("hex");
  return { signature, bodyHash };
}

/**
 * Produce the v3 outbound header set:
 *
 *   - `X-Maw-From`             sender, `<oracle>:<node>`
 *   - `X-Maw-Signature-V3`     HMAC-SHA256(peerKey, payload), lowercase hex
 *   - `X-Maw-Timestamp`        numeric seconds — REUSED from v2 (single source
 *                              of truth on the wire; v2 + v3 share clock skew)
 *   - `X-Maw-Auth-Version: v3` signal the verifier should look at the v3 slot
 *
 * v3 is ADDITIVE: callers stack these on top of the v2 `X-Maw-Signature` /
 * `X-Maw-Timestamp` pair so a fleet still on v2-only verifiers keeps
 * working. The v3 timestamp is the same number as the v2 one — when the
 * caller signs both, both signatures bind the same instant.
 */
export function signHeadersV3(opts: {
  peerKey: string;
  fromAddress: string;
  method: string;
  path: string;
  body?: string | Uint8Array;
  timestamp?: number;
}): Record<string, string> {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const { signature } = signRequestV3({
    peerKey: opts.peerKey,
    fromAddress: opts.fromAddress,
    method: opts.method,
    path: opts.path,
    timestamp: ts,
    body: opts.body,
  });
  return {
    "X-Maw-From": opts.fromAddress,
    "X-Maw-Signature-V3": signature,
    "X-Maw-Timestamp": String(ts),
    "X-Maw-Auth-Version": "v3",
  };
}

/**
 * Derive the sender's `<oracle>:<node>` from-address from config.
 *
 * Per #804 research:  `<config.oracle ?? "mawjs">:<config.node>`. Returns
 * null when `config.node` is unset — callers MUST NOT v3-sign in that
 * posture because the verifier has nothing stable to anchor the TOFU
 * lookup against (single-node operators stay on v1/v2 token).
 */
export function resolveFromAddress(config: { oracle?: string; node?: string }): string | null {
  if (!config.node) return null;
  const oracle = config.oracle ?? DEFAULT_ORACLE;
  return `${oracle}:${config.node}`;
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
    const allowPeersWithoutToken = config.allowPeersWithoutToken === true;

    const url = new URL(c.req.url);
    const path = url.pathname;

    // Not a protected path → pass (reads remain public so the Office UI works)
    if (!isProtected(path, c.req.method)) return next();

    // Check if loopback (local CLI / browser on same machine).
    // SECURITY: only the TCP source address is authoritative — X-Forwarded-For
    // and X-Real-IP are attacker-controlled headers and MUST NOT influence
    // auth decisions. See #191 for the empirically-verified RCE vector
    // (Test 3 on mba: POST /api/send to a non-loopback interface with
    // `X-Forwarded-For: 127.0.0.1` bypassed HMAC entirely).
    //
    // Path B (local reverse-proxy sidecar forwarding to 127.0.0.1) is now
    // operator-gated by `config.trustLoopback`:
    //   - true (default, legacy): loopback still bypasses auth — load-bearing
    //     for local CLI until it self-signs. Operators behind reverse proxies
    //     MUST flip this to false or they're exposed to Path B.
    //   - false: loopback requests must sign like any other peer. This is
    //     the fully-hardened posture; requires CLI self-signing (follow-up).
    const clientIp = (c.env as any)?.server?.requestIP?.(c.req.raw)?.address;
    const trustLoopback = config.trustLoopback !== false; // default true

    if (trustLoopback && isLoopback(clientIp)) return next();

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
    const authVersion = (c.req.header("x-maw-auth-version") ?? "v1").toLowerCase();

    if (!sig || !ts) {
      return c.json({ error: "federation auth required", reason: "missing_signature" }, 401);
    }

    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp)) {
      return c.json({ error: "federation auth failed", reason: "invalid_timestamp" }, 401);
    }

    // Body hash is load-bearing for v2; absent/empty for v1.
    // Reading the body here consumes the stream; subsequent handlers must
    // rely on c.req.text() / c.req.json() which Hono re-reads from the
    // cached raw request. In Hono 4+, c.req.raw.clone() + arrayBuffer()
    // is the safe pattern — the middleware reads a clone, the handler
    // reads the original.
    let bodyHash = "";
    if (authVersion === "v2") {
      try {
        const clone = c.req.raw.clone();
        const buf = new Uint8Array(await clone.arrayBuffer());
        bodyHash = hashBody(buf);
      } catch (err) {
        console.warn(`[auth] v2 body read failed for ${c.req.method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
        return c.json({ error: "federation auth failed", reason: "body_read_failed" }, 401);
      }
    }

    if (!verify(token, c.req.method, path, timestamp, sig, bodyHash)) {
      const now = Math.floor(Date.now() / 1000);
      const delta = Math.abs(now - timestamp);
      const reason = delta > WINDOW_SEC ? "timestamp_expired" : "signature_invalid";
      console.warn(`[auth] rejected ${c.req.method} ${path} from ${clientIp}: ${reason} (delta=${delta}s, version=${authVersion})`);
      return c.json({ error: "federation auth failed", reason, ...(delta > WINDOW_SEC ? { delta } : {}) }, 401);
    }

    // v1 is a deprecation path — warn so operators see the attack surface.
    if (authVersion === "v1") {
      console.warn(`[auth] v1 (body-unsigned) accepted for ${c.req.method} ${path} from ${clientIp} — peer should upgrade to v2; body-swap replay is possible until they do`);
    }

    return next();
  };
}

// ===========================================================================
// #804 Step 4 VERIFY — Per-peer "from:" signature verification + O6 enforcement
// ===========================================================================
//
// Companion to signRequest() above (Step 4 SIGN). Layer 2 on top of the
// fleet HMAC: HMAC gates *fleet membership*; from-signing gates *per-peer
// continuity* — "are you the peer I last spoke with?". Both layers can ride
// the same request; the wire-shared `x-maw-signature` slot is interpreted as
// from-sig when `x-maw-from` is present and as fleet-HMAC otherwise. The
// elysia plugins are arranged so each layer skips itself when the other owns
// the request — see src/lib/elysia-auth.ts.
//
// Wire format (matches signRequest above exactly):
//   x-maw-from        : "<oracle>:<node>" — sender's canonical identity
//   x-maw-signed-at   : ISO 8601 UTC timestamp (e.g. 2026-04-28T17:42:00.000Z)
//   x-maw-signature   : HMAC-SHA256(peerKey, payload), lowercase hex
//
// Canonical signed payload (matches signRequest):
//   `<from>\n<signedAt>\n<METHOD>\n<path>\n<bodyHashHex>`
//
// `bodyHashHex` = hashBody(body) — empty string for empty body.
//
// O6 truth table (ADR docs/federation/0001-peer-identity.md):
//   | Cached pubkey? | Sender signed? | Outcome
//   | no             | no             | accept (legacy TOFU bootstrap)
//   | no             | yes            | accept (TOFU record-only — alpha)
//   | yes            | no             | REFUSE ("you used to sign")
//   | yes            | yes valid      | accept
//   | yes            | yes mismatch   | REFUSE + alert
//
// The cached "pubkey" in this scheme is — symmetric — the same long-lived
// per-peer secret the sender signed with. Step 1 publishes it via
// /api/identity (this is intentional today; v27 may switch to asymmetric
// ed25519 derived from a seed, in which case both signRequest and
// verifyRequest swap their crypto primitive — the wire format above is
// stable). See peer-key.ts for the seed lifecycle.
//
// Hard cuts at v27.0.0: see ADR migration section.

/** Decision returned by verifyRequest — five O6 outcomes + skew + malformed. */
export type FromVerifyDecision =
  | { kind: "accept-legacy"; reason: "no-cache-no-sig" }
  | { kind: "accept-tofu-record"; reason: "no-cache-signed"; from: string }
  | { kind: "accept-verified"; reason: "cache-sig-valid"; from: string }
  | { kind: "refuse-unsigned"; reason: "cache-no-sig"; from?: string }
  | { kind: "refuse-mismatch"; reason: "signature-invalid"; from: string }
  | { kind: "refuse-skew"; reason: "timestamp-out-of-window"; from?: string; delta: number }
  | { kind: "refuse-malformed"; reason: string };

/** Headers shape accepted by verifyRequest — case-insensitive lookup. */
export interface VerifyHeaders {
  /** Case-insensitive `get`, matches Bun/Web Fetch `Headers` and Node's lowercase Record. */
  get(name: string): string | null | undefined;
}

/**
 * Adapter so callers can pass a plain Record (tests) or `request.headers`
 * (Elysia / Bun fetch — these already implement .get(), so they pass through).
 */
export function asVerifyHeaders(h: Record<string, string | undefined> | VerifyHeaders): VerifyHeaders {
  if (typeof (h as VerifyHeaders).get === "function") return h as VerifyHeaders;
  const lc: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h as Record<string, string | undefined>)) {
    lc[k.toLowerCase()] = v;
  }
  return { get: (name: string) => lc[name.toLowerCase()] ?? null };
}

/**
 * Build the canonical signed payload. MUST match signRequest's layout:
 *   `<from>\n<signedAt>\n<METHOD>\n<path>\n<bodyHashHex>`
 * (Field order is load-bearing — drift here = silent verification failure.)
 */
export function buildFromSignPayload(
  from: string,
  signedAt: string,
  method: string,
  path: string,
  bodyHash: string,
): string {
  return `${from}\n${signedAt}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/**
 * HMAC-SHA256 verify with constant-time comparison. Returns true iff the
 * provided hex signature equals HMAC(secret, payload).
 */
export function verifyHmacSig(secret: string, payload: string, signatureHex: string): boolean {
  if (!signatureHex || !/^[0-9a-fA-F]+$/.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Lookup of cached secret/pubkey for a given `from` identity (e.g. peers store). */
export type FromPubkeyLookup = (from: string) => string | undefined | null;

/**
 * Parse an ISO 8601 timestamp into unix seconds. Returns null on malformed.
 * Accepts the format produced by `new Date().toISOString()` (the SIGN side).
 */
function parseIsoSeconds(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Verify the per-peer `from:` signing layer on an incoming request.
 *
 * Inputs:
 *   - method, path: HTTP method + URL pathname (path is what the sender signed)
 *   - headers: incoming request headers (case-insensitive .get())
 *   - body: the raw request body bytes/string used for the body-hash binding;
 *           empty string / Uint8Array(0) is allowed (e.g. GET-style writes).
 *   - lookupPubkey: returns the cached pubkey (hex) for a peer, or undefined.
 *
 * Returns a tagged decision the caller acts on. The function does not throw —
 * `refuse-*` kinds carry a reason; `accept-*` kinds carry the verified `from`
 * when applicable. Caller is responsible for translating refuse into HTTP 401.
 *
 * Clock skew: rejects |signed_at - now| > 300s. Symmetric (past + future).
 * Default 5 min (not 60s) accommodates real-world heterogeneous fleets per ADR.
 */
export function verifyRequest(args: {
  method: string;
  path: string;
  headers: VerifyHeaders | Record<string, string | undefined>;
  body: string | Uint8Array | undefined | null;
  lookupPubkey: FromPubkeyLookup;
  /** Override "now" in seconds (test seam). Defaults to Date.now()/1000. */
  now?: number;
}): FromVerifyDecision {
  const headers = asVerifyHeaders(args.headers);
  const from = (headers.get("x-maw-from") ?? "").trim();
  const sig = (headers.get("x-maw-signature") ?? "").trim();
  const signedAtIso = (headers.get("x-maw-signed-at") ?? "").trim();

  const cached = from ? (args.lookupPubkey(from) ?? undefined) : undefined;
  // "Signed" means the from-signing trio is present. The fleet-HMAC layer
  // also produces an x-maw-signature, but it's accompanied by x-maw-timestamp,
  // not x-maw-from. We key on x-maw-from to disambiguate the two layers.
  const signed = !!from && !!sig && !!signedAtIso;

  // --- O6 row 1: no cache + unsigned → accept (legacy bootstrap) ---
  if (!cached && !signed) {
    return { kind: "accept-legacy", reason: "no-cache-no-sig" };
  }

  // --- O6 row 2: no cache + signed → accept (record-only; alpha) ---
  if (!cached && signed) {
    return { kind: "accept-tofu-record", reason: "no-cache-signed", from };
  }

  // --- O6 row 3: cached + unsigned → REFUSE ("you used to sign") ---
  if (cached && !signed) {
    return { kind: "refuse-unsigned", reason: "cache-no-sig", from: from || undefined };
  }

  // --- O6 rows 4 & 5: cached + signed → verify ---
  // Defensive: cached + signed should mean the trio is present, but malformed
  // headers can land us here with a partial trio — bail on missing pieces.
  if (!from) return { kind: "refuse-malformed", reason: "missing-from" };
  if (!sig) return { kind: "refuse-malformed", reason: "missing-signature" };

  const signedAtSec = parseIsoSeconds(signedAtIso);
  if (signedAtSec === null) {
    return { kind: "refuse-malformed", reason: "invalid-signed-at" };
  }
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const delta = Math.abs(now - signedAtSec);
  if (delta > FROM_SIG_WINDOW_SEC) {
    return { kind: "refuse-skew", reason: "timestamp-out-of-window", from, delta };
  }
  const bodyHash = hashBody(args.body);
  const payload = buildFromSignPayload(from, signedAtIso, args.method, args.path, bodyHash);
  if (!verifyHmacSig(cached!, payload, sig)) {
    return { kind: "refuse-mismatch", reason: "signature-invalid", from };
  }
  return { kind: "accept-verified", reason: "cache-sig-valid", from };
}

/** True if the decision should result in HTTP 401 (refuse). */
export function isRefuseDecision(d: FromVerifyDecision): boolean {
  return d.kind.startsWith("refuse-");
}
