// Proxy API — Elysia route definitions

import { Elysia } from "elysia";
import { setProxySessionCookie, hasValidProxySessionCookie, parseProxySignature } from "./proxy-auth";
import { isKnownMethod, isReadOnlyMethod, isPathProxyable, isProxyShellPeerAllowed, READONLY_METHODS, MUTATING_METHODS } from "./proxy-trust";
import { resolveProxyPeerUrl, relayHttpToPeer } from "./proxy-relay";

export interface ProxyApiDeps {
  setProxySessionCookie?: typeof setProxySessionCookie;
  hasValidProxySessionCookie?: typeof hasValidProxySessionCookie;
  parseProxySignature?: typeof parseProxySignature;
  isKnownMethod?: typeof isKnownMethod;
  isReadOnlyMethod?: typeof isReadOnlyMethod;
  isPathProxyable?: typeof isPathProxyable;
  isProxyShellPeerAllowed?: typeof isProxyShellPeerAllowed;
  resolveProxyPeerUrl?: typeof resolveProxyPeerUrl;
  relayHttpToPeer?: typeof relayHttpToPeer;
}

export function createProxyApi(deps: ProxyApiDeps = {}) {
  const setProxyCookie = deps.setProxySessionCookie ?? setProxySessionCookie;
  const hasValidCookie = deps.hasValidProxySessionCookie ?? hasValidProxySessionCookie;
  const parseSignature = deps.parseProxySignature ?? parseProxySignature;
  const knownMethod = deps.isKnownMethod ?? isKnownMethod;
  const readOnlyMethod = deps.isReadOnlyMethod ?? isReadOnlyMethod;
  const pathProxyable = deps.isPathProxyable ?? isPathProxyable;
  const shellPeerAllowed = deps.isProxyShellPeerAllowed ?? isProxyShellPeerAllowed;
  const resolvePeerUrl = deps.resolveProxyPeerUrl ?? resolveProxyPeerUrl;
  const relayToPeer = deps.relayHttpToPeer ?? relayHttpToPeer;

  const proxyApi = new Elysia();

/**
 * GET /api/proxy/session — bootstrap a proxy session cookie.
 */
proxyApi.get("/proxy/session", ({ set }) => {
  setProxyCookie(set);
  return { ok: true, rotates: "on_server_restart" };
});

/**
 * POST /api/proxy — forward an HTTP request to a peer.
 *
 * Body: { peer: string, method: string, path: string, body?: string, signature: string }
 */
proxyApi.post("/proxy", async ({ body, set, request }) => {
  if (!body || typeof body !== "object") {
    set.status = 400;
    return { error: "invalid_body" };
  }

  const { peer, method, path, body: forwardBody, signature } = body as {
    peer?: string;
    method?: string;
    path?: string;
    body?: string;
    signature?: string;
  };

  if (!peer || !method || !path || !signature) {
    set.status = 400;
    return { error: "missing_fields", required: ["peer", "method", "path", "signature"] };
  }

  // 1. Parse signature
  const parsed = parseSignature(signature);
  if (!parsed) {
    set.status = 400;
    return { error: "bad_signature", expected: "[host:agent]" };
  }

  // 2. Session cookie check
  // Bypass ONLY when explicitly in dev mode. Default (unset NODE_ENV) = secure.
  const devBypass = process.env.NODE_ENV === "development";
  if (!devBypass && !hasValidCookie(request)) {
    set.status = 401;
    return { error: "no_session", hint: "GET /api/proxy/session first" };
  }

  // 3. Method classification
  if (!knownMethod(method)) {
    set.status = 400;
    return { error: "unknown_method", method, allowed: [...READONLY_METHODS, ...MUTATING_METHODS] };
  }

  // 4. Trust boundary: readonly methods always OK; mutations need allowlist
  const readonly = readOnlyMethod(method);
  if (!readonly) {
    const allowed = shellPeerAllowed(parsed.originHost);
    if (!allowed) {
      set.status = 403;
      return {
        error: "mutation_denied",
        origin: parsed.originHost,
        method,
        hint: parsed.isAnon
          ? "anonymous browser visitors can only GET; mutations require proxy.shellPeers allowlist"
          : "add this origin to config.proxy.shellPeers to permit mutations",
      };
    }
  }

  // 5. Path allowlist
  if (!pathProxyable(path)) {
    set.status = 403;
    return { error: "path_not_proxyable", path, hint: "only v1 REST endpoints are proxyable in the prototype" };
  }

  // 6. Resolve peer
  const peerUrl = resolvePeerUrl(peer);
  if (!peerUrl) {
    set.status = 404;
    return { error: "unknown_peer", peer };
  }

  // 7. Relay and return
  try {
    const result = await relayToPeer(peerUrl, method, path, forwardBody);
    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      from: peerUrl,
      elapsed_ms: result.elapsedMs,
      trust_tier: readonly ? "readonly_method" : "shell_allowlisted",
    };
  } catch (err: any) {
    set.status = 502;
    return { error: "relay_failed", peer: peerUrl, reason: err?.message ?? String(err) };
  }
});

  return proxyApi;
}

export const proxyApi = createProxyApi();
