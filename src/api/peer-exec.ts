/**
 * POST /api/peer/exec — HTTP transport layer for the /wormhole protocol.
 *
 * PROTOTYPE — iteration 3 of the federation-join-easy proof. See
 * `mawui-oracle/ψ/writing/federation-join-easy.md` for the full architectural
 * context. This file is the server half of the "global maw-ui + ?host= via
 * peer-exec relay" pattern — a companion to `wormholeClient.ts` in maw-ui.
 *
 * ## Why this endpoint exists
 *
 * `src/lib/api.ts` in maw-ui implements the drizzle.studio `?host=` pattern:
 * a hosted UI can point itself at any backend via a query param. That works
 * cleanly for HTTPS peers on the public internet, but hits three walls for
 * the "lazy-setup federation via global UI" case:
 *
 *   1. **Mixed-content rule**: an HTTPS origin (e.g. local.buildwithoracle.com)
 *      cannot fetch from an HTTP LAN peer (e.g. http://10.20.0.7:3456). This
 *      is a browser-level protocol rule, CORS-independent.
 *   2. **WireGuard-only peers**: the browser doesn't have WG routes; only the
 *      local backend does. A public origin cannot reach a WG-only peer
 *      directly.
 *   3. **Unified auth**: browsers don't know `federationToken`. Giving every
 *      visitor an HMAC token is a non-starter.
 *
 * The peer-exec relay fixes all three by making the local backend the trust
 * gateway: browser → local backend is same-origin (no mixed-content, no CORS,
 * no new auth); local backend → peer uses the existing `signHeaders()` HMAC
 * mechanism.
 *
 * NOTE: this does NOT sidestep CORS — `src/server.ts:40` already runs
 * `app.use("/api/*", cors())` (default permissive) and lines 36-39 set
 * `Access-Control-Allow-Private-Network: true`. CORS and PNA are already
 * handled for the direct-fetch path. The peer-exec relay exists for the
 * mixed-content + WG + unified-auth problems, not for CORS. See the proof
 * doc for the corrected motivation list (iteration 2, ~23:55).
 *
 * ## Trust boundary
 *
 * Incoming requests carry a `[<origin-host>:<origin-agent>]` signature per
 * the /wormhole skill v0.1 spec. The trust-check is split into two tiers:
 *
 *   - **Readonly commands** (`/dig`, `/trace`, `/recap`, `/standup`, grep-only
 *     reads of `ψ/memory/`): always permitted regardless of origin. This is
 *     the same policy as the tmux-hey wormhole transport.
 *   - **Shell / write / mutate commands**: require the origin-host to appear
 *     in `config.wormhole.shellPeers`. Browser visitors carry
 *     `[<origin>:anon-<nonce>]` signatures; by convention `anon-*` never
 *     appears in shellPeers, so anonymous browser calls are permanently
 *     read-only.
 *
 * ## Same-origin cookie (Path B mitigation)
 *
 * `src/lib/federation-auth.ts` has a known weakness (#191 Path B): a local
 * cloudflared sidecar forwarding to `127.0.0.1` makes the TCP source look
 * legitimately loopback, bypassing HMAC entirely. For the peer-exec endpoint
 * specifically, we CANNOT rely on loopback bypass because the browser will
 * almost certainly reach us via cloudflared when deployed to a public origin.
 *
 * Instead, this endpoint issues a localhost-only cookie on first request
 * (`pe_session`) and verifies it on subsequent calls. The cookie is a random
 * 128-bit token generated at server startup, stored in memory only. Rotating
 * maw-js invalidates all browser sessions, which is the correct security
 * posture for a prototype. A future iteration can harden this with a
 * persisted token + rotation schedule.
 *
 * ## Status
 *
 * - **Iteration 3 prototype** — drafted on `feat/wormhole-http-endpoint-draft`
 *   branch, NOT merged to main, NOT part of a PR yet.
 * - Design-locked with mawjs-oracle (oracle-world side) via maw hey coord
 *   pings. Awaiting (a) Nat's confirmation on the hosted-URL deploy ownership
 *   before this becomes a real PR, (b) optional white:mawjs /wormhole trace
 *   findings if they wake and respond.
 * - Coexists with the tmux-hey transport in the /wormhole skill v0.1. This
 *   is the HTTP parallel transport planned for /wormhole v0.2.
 */

import { Hono } from "hono";
import { randomBytes } from "crypto";
import { loadConfig } from "../config";
import { signHeaders } from "../lib/federation-auth";

// --- Session cookie (in-memory, rotates on server restart) ---------------

const PE_SESSION_TOKEN = randomBytes(16).toString("hex");
const PE_COOKIE_NAME = "pe_session";
const PE_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

function setSessionCookie(c: any): void {
  // HttpOnly so JS can't read it, SameSite=Strict so it's not sent cross-site,
  // no Secure flag so it works on http://localhost dev servers.
  c.header(
    "Set-Cookie",
    `${PE_COOKIE_NAME}=${PE_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/peer; Max-Age=${PE_COOKIE_MAX_AGE}`,
  );
}

function hasValidSessionCookie(c: any): boolean {
  const cookieHeader = c.req.header("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${PE_COOKIE_NAME}=([a-f0-9]+)`));
  return match !== null && match[1] === PE_SESSION_TOKEN;
}

// --- Signature parsing ----------------------------------------------------

interface ParsedSignature {
  originHost: string;
  originAgent: string;
  isAnon: boolean;
}

export function parseSignature(signature: string): ParsedSignature | null {
  const m = signature.match(/^\[([^:\]]+):([^\]]+)\]$/);
  if (!m) return null;
  const [, originHost, originAgent] = m;
  return {
    originHost,
    originAgent,
    isAnon: originAgent.startsWith("anon-"),
  };
}

// --- Trust boundary -------------------------------------------------------

/**
 * Readonly commands. These are always permitted regardless of origin.
 * Mirrors the /wormhole skill v0.1 trust boundary (which auto-permits /dig,
 * /trace, and read-only grep queries into ψ/memory/).
 */
const READONLY_CMDS = [
  "/dig",
  "/trace",
  "/recap",
  "/standup",
  "/who-are-you",
  "/philosophy",
  "/where-we-are",
];

export function isReadOnlyCmd(cmd: string): boolean {
  const trimmed = cmd.trim();
  return READONLY_CMDS.some((prefix) =>
    trimmed === prefix || trimmed.startsWith(prefix + " "),
  );
}

export function isShellPeerAllowed(originHost: string): boolean {
  if (originHost.startsWith("anon-")) return false;
  const config = loadConfig() as any;
  const allowed: string[] = config?.wormhole?.shellPeers ?? [];
  return allowed.includes(originHost);
}

// --- Peer URL resolution --------------------------------------------------

/**
 * Resolve a peer name (e.g. "white", "oracle-world") to a base URL using
 * the existing namedPeers config. Returns null if the peer is unknown.
 */
export function resolvePeerUrl(peer: string): string | null {
  const config = loadConfig() as any;
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const match = namedPeers.find((p) => p.name === peer);
  if (match) return match.url;

  // Also accept a literal host:port (no protocol) — default to http
  if (/^[\w.-]+:\d+$/.test(peer)) return `http://${peer}`;

  // Or a full URL
  if (peer.startsWith("http://") || peer.startsWith("https://")) return peer;

  return null;
}

// --- Relay ---------------------------------------------------------------

interface RelayResult {
  output: string;
  from: string;
  elapsedMs: number;
  status: number;
}

/**
 * Relay a peer-exec request to a peer via HTTP, signing the outgoing call
 * with the existing federation-auth HMAC. The peer's maw-js must be running
 * and reachable from this backend's network (WG, LAN, or public).
 *
 * For the iteration-3 prototype, the relay simply forwards as a POST to the
 * peer's own /api/peer/exec endpoint (if it exists) — recursively.
 * Iteration 4 will add a fallback to the existing /api/send endpoint for
 * peers that don't yet support the peer-exec route.
 */
async function relayToPeer(
  peerUrl: string,
  body: { cmd: string; args: string[]; signature: string },
): Promise<RelayResult> {
  const start = Date.now();
  const path = "/api/peer/exec";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // Sign the outgoing relay with the existing HMAC mechanism. The peer's
  // federation-auth middleware will verify if both sides share a token.
  const config = loadConfig() as any;
  const token = config?.federationToken;
  if (token) {
    Object.assign(headers, signHeaders(token, "POST", path));
  }

  const response = await fetch(`${peerUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return {
    output: text,
    from: peerUrl,
    elapsedMs: Date.now() - start,
    status: response.status,
  };
}

// --- Route ---------------------------------------------------------------

export const peerExecApi = new Hono();

/**
 * GET /api/peer/session — issue a session cookie to a same-origin caller.
 * The UI calls this once on page load; subsequent POSTs carry the cookie.
 */
peerExecApi.get("/peer/session", (c) => {
  setSessionCookie(c);
  return c.json({ ok: true, rotates: "on_server_restart" });
});

/**
 * POST /api/peer/exec — relay a command to a peer.
 *
 * Body: { peer: string, cmd: string, args?: string[], signature: string }
 *
 * Trust flow:
 *   1. Parse signature — reject malformed
 *   2. Check session cookie — reject if missing (unless dev bypass)
 *   3. If cmd is readonly → permit regardless of origin
 *   4. If cmd is NOT readonly → require origin in config.wormhole.shellPeers
 *   5. Resolve peer URL — reject if unknown
 *   6. Relay via HTTP with HMAC-signed headers
 *   7. Return peer's response verbatim
 */
peerExecApi.post("/peer/exec", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }

  const { peer, cmd, args = [], signature } = body as {
    peer?: string;
    cmd?: string;
    args?: string[];
    signature?: string;
  };

  if (!peer || !cmd || !signature) {
    return c.json({ error: "missing_fields", required: ["peer", "cmd", "signature"] }, 400);
  }

  // 1. Parse signature
  const parsed = parseSignature(signature);
  if (!parsed) {
    return c.json({ error: "bad_signature", expected: "[host:agent]" }, 400);
  }

  // 2. Session cookie check (skipped in dev — loopback bypass is acceptable
  //    for local development; production deployments behind cloudflared MUST
  //    have a valid cookie).
  const devBypass = process.env.NODE_ENV !== "production";
  if (!devBypass && !hasValidSessionCookie(c)) {
    return c.json({ error: "no_session", hint: "GET /api/peer/session first" }, 401);
  }

  // 3 + 4. Trust boundary
  const readonly = isReadOnlyCmd(cmd);
  if (!readonly) {
    const allowed = isShellPeerAllowed(parsed.originHost);
    if (!allowed) {
      return c.json(
        {
          error: "shell_peer_denied",
          origin: parsed.originHost,
          hint: parsed.isAnon
            ? "anonymous browser visitors are read-only; only /dig, /trace, /recap and similar work"
            : "add this origin to config.wormhole.shellPeers to permit shell cmds",
        },
        403,
      );
    }
  }

  // 5. Resolve peer
  const peerUrl = resolvePeerUrl(peer);
  if (!peerUrl) {
    return c.json({ error: "unknown_peer", peer }, 404);
  }

  // 6 + 7. Relay and return
  try {
    const result = await relayToPeer(peerUrl, { cmd, args, signature });
    return c.json({
      output: result.output,
      from: result.from,
      elapsed_ms: result.elapsedMs,
      status: result.status,
      trust_tier: readonly ? "readonly" : "shell_allowlisted",
    });
  } catch (err: any) {
    return c.json({ error: "relay_failed", peer: peerUrl, reason: err?.message ?? String(err) }, 502);
  }
});
