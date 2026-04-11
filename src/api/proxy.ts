/**
 * POST /api/proxy — generic HTTP proxy for REST access to HTTP-LAN peers
 * from HTTPS origins (the mixed-content-blocked case).
 *
 * PROTOTYPE — iteration 6 of the federation-join-easy proof. Drafted on the
 * `feat/api-proxy-http-peers` branch (**SEPARATE** from
 * `feat/wormhole-http-endpoint-draft`). See
 * `mawui-oracle/ψ/writing/federation-join-easy.md` for full context and
 * the iteration-5 architectural refinement that made this endpoint necessary.
 *
 * ## Why this is a separate endpoint from /api/wormhole/request
 *
 * Iteration 5 caught a shape confusion: the /wormhole protocol is for
 * **signed command execution** (`/dig`, `/trace`, `/recap`), NOT for
 * arbitrary REST proxying. They serve different needs:
 *
 *   - `/api/wormhole/request` — RPC-shaped, returns a command output string,
 *     enforces per-verb trust boundary with a readonly whitelist
 *   - `/api/proxy` (this file) — HTTP-shaped, forwards a full request to a
 *     peer's API surface, enforces per-HTTP-method trust boundary
 *
 * Merging them into one endpoint would collapse two different trust models
 * (per-verb vs per-method) and two different response shapes (output string
 * vs HTTP response envelope) — worse, it would bake the confusion into the
 * wire protocol and make it hard to split later.
 *
 * ## The problem this solves
 *
 * Iteration 5's `peerConnection.ts` classifies `?host=http://10.20.0.7:3456`
 * as `mixed-content-blocked` when the origin is HTTPS. That's correct —
 * the browser refuses to fetch HTTP resources from an HTTPS origin per the
 * active-content mixed-content rule. But the caller still needs to read
 * `/api/config` or `/api/sessions` from that peer. The only way is to relay
 * through the local backend (which is same-origin to the browser).
 *
 * That's what this endpoint does: browser POSTs `{peer, method, path, body?}`
 * to a same-origin `/api/proxy`, the local backend signs the outbound
 * request with federation-auth HMAC, fetches from the peer, and returns the
 * response verbatim.
 *
 * ## Trust boundary
 *
 * Because this forwards arbitrary HTTP, the trust model is per-method:
 *
 *   - **GET / HEAD / OPTIONS**: permitted for anonymous browser visitors.
 *     These are read-only by HTTP semantics and map to the same risk
 *     profile as the /wormhole readonly whitelist.
 *   - **POST / PUT / PATCH / DELETE**: require the origin-host in
 *     `config.proxy.shellPeers` allowlist. Anonymous browser visitors
 *     (`anon-*` origins) are never allowlisted by convention.
 *
 * NOTE: this is separate from `config.wormhole.shellPeers`. A peer might be
 * trusted for command execution but not for arbitrary mutations (or vice
 * versa). Split configs let the operator make that call per surface.
 *
 * ## Path allowlist (defense in depth)
 *
 * Even for GET, we allowlist the path prefixes that make sense to proxy.
 * Currently: `/api/config`, `/api/fleet-config`, `/api/feed`, `/api/plugins`,
 * `/api/federation/status`, `/api/sessions`, `/api/worktrees`, `/api/teams`.
 * These are the v1 REST endpoints that maw-ui actually reads. Anything
 * outside this list returns `403 path_not_proxyable`. This is a prototype
 * guardrail — iteration 6+ could relax it to a per-peer config.
 *
 * ## Session cookie auth
 *
 * Uses the SAME cookie shape as `/api/wormhole/session` but with its own
 * name (`proxy_session`) and its own rotating token. A browser that has
 * opted into wormhole does NOT automatically get proxy access and vice
 * versa — the caller must explicitly GET `/api/proxy/session` first.
 *
 * This is deliberate: the two endpoints have different trust models and
 * different failure modes. A compromise of one shouldn't leak into the
 * other.
 */

import { Hono } from "hono";
import { randomBytes } from "crypto";
import { loadConfig } from "../config";
import { signHeaders } from "../lib/federation-auth";

// --- Session cookie (in-memory, rotates on server restart) ---------------

const PROXY_SESSION_TOKEN = randomBytes(16).toString("hex");
const PROXY_COOKIE_NAME = "proxy_session";
const PROXY_COOKIE_MAX_AGE = 60 * 60 * 24;

function setProxySessionCookie(c: any): void {
  c.header(
    "Set-Cookie",
    `${PROXY_COOKIE_NAME}=${PROXY_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/proxy; Max-Age=${PROXY_COOKIE_MAX_AGE}`,
  );
}

function hasValidProxySessionCookie(c: any): boolean {
  const cookieHeader = c.req.header("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${PROXY_COOKIE_NAME}=([a-f0-9]+)`));
  return match !== null && match[1] === PROXY_SESSION_TOKEN;
}

// --- Signature parsing (local copy — not shared with wormhole) -----------

// The signature shape is the same as /wormhole but parsed locally to avoid
// coupling the two files. If we ever share this, it should move to
// src/lib/signature.ts with explicit test coverage on BOTH consumers.

interface ParsedSignature {
  originHost: string;
  originAgent: string;
  isAnon: boolean;
}

export function parseProxySignature(signature: string): ParsedSignature | null {
  const m = signature.match(/^\[([^:\]]+):([^\]]+)\]$/);
  if (!m) return null;
  const [, originHost, originAgent] = m;
  return { originHost, originAgent, isAnon: originAgent.startsWith("anon-") };
}

// --- HTTP method classification ------------------------------------------

const READONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
  const config = loadConfig() as any;
  const allowed: string[] = config?.proxy?.shellPeers ?? [];
  return allowed.includes(originHost);
}

// --- Peer URL resolution (same as wormhole — acceptable duplication) ----

export function resolveProxyPeerUrl(peer: string): string | null {
  const config = loadConfig() as any;
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const match = namedPeers.find((p) => p.name === peer);
  if (match) return match.url;
  if (/^[\w.-]+:\d+$/.test(peer)) return `http://${peer}`;
  if (peer.startsWith("http://") || peer.startsWith("https://")) return peer;
  return null;
}

// --- Relay ---------------------------------------------------------------

interface RelayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
}

async function relayHttpToPeer(
  peerUrl: string,
  method: string,
  path: string,
  body: string | undefined,
): Promise<RelayResult> {
  const start = Date.now();
  const upper = method.toUpperCase();
  const outHeaders: Record<string, string> = {};

  // Sign outbound with existing HMAC mechanism
  const config = loadConfig() as any;
  const token = config?.federationToken;
  if (token) {
    Object.assign(outHeaders, signHeaders(token, upper, path));
  }

  // Only set Content-Type for methods that can carry a body
  if (body !== undefined && !READONLY_METHODS.has(upper)) {
    outHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(`${peerUrl}${path}`, {
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
    elapsedMs: Date.now() - start,
  };
}

// --- Route ---------------------------------------------------------------

export const proxyApi = new Hono();

/**
 * GET /api/proxy/session — bootstrap a proxy session cookie.
 */
proxyApi.get("/proxy/session", (c) => {
  setProxySessionCookie(c);
  return c.json({ ok: true, rotates: "on_server_restart" });
});

/**
 * POST /api/proxy — forward an HTTP request to a peer.
 *
 * Body: { peer: string, method: string, path: string, body?: string, signature: string }
 */
proxyApi.post("/proxy", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }

  const { peer, method, path, body: forwardBody, signature } = body as {
    peer?: string;
    method?: string;
    path?: string;
    body?: string;
    signature?: string;
  };

  if (!peer || !method || !path || !signature) {
    return c.json(
      { error: "missing_fields", required: ["peer", "method", "path", "signature"] },
      400,
    );
  }

  // 1. Parse signature
  const parsed = parseProxySignature(signature);
  if (!parsed) {
    return c.json({ error: "bad_signature", expected: "[host:agent]" }, 400);
  }

  // 2. Session cookie check (dev bypass on NODE_ENV !== production)
  const devBypass = process.env.NODE_ENV !== "production";
  if (!devBypass && !hasValidProxySessionCookie(c)) {
    return c.json(
      { error: "no_session", hint: "GET /api/proxy/session first" },
      401,
    );
  }

  // 3. Method classification
  if (!isKnownMethod(method)) {
    return c.json(
      { error: "unknown_method", method, allowed: [...READONLY_METHODS, ...MUTATING_METHODS] },
      400,
    );
  }

  // 4. Trust boundary: readonly methods always OK; mutations need allowlist
  const readonly = isReadOnlyMethod(method);
  if (!readonly) {
    const allowed = isProxyShellPeerAllowed(parsed.originHost);
    if (!allowed) {
      return c.json(
        {
          error: "mutation_denied",
          origin: parsed.originHost,
          method,
          hint: parsed.isAnon
            ? "anonymous browser visitors can only GET; mutations require proxy.shellPeers allowlist"
            : "add this origin to config.proxy.shellPeers to permit mutations",
        },
        403,
      );
    }
  }

  // 5. Path allowlist
  if (!isPathProxyable(path)) {
    return c.json(
      { error: "path_not_proxyable", path, hint: "only v1 REST endpoints are proxyable in the prototype" },
      403,
    );
  }

  // 6. Resolve peer
  const peerUrl = resolveProxyPeerUrl(peer);
  if (!peerUrl) {
    return c.json({ error: "unknown_peer", peer }, 404);
  }

  // 7. Relay and return
  try {
    const result = await relayHttpToPeer(peerUrl, method, path, forwardBody);
    return c.json({
      status: result.status,
      headers: result.headers,
      body: result.body,
      from: peerUrl,
      elapsed_ms: result.elapsedMs,
      trust_tier: readonly ? "readonly_method" : "shell_allowlisted",
    });
  } catch (err: any) {
    return c.json(
      { error: "relay_failed", peer: peerUrl, reason: err?.message ?? String(err) },
      502,
    );
  }
});
