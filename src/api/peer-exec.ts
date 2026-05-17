/**
 * POST /api/peer/exec -- HTTP transport layer for the /wormhole protocol.
 *
 * PROTOTYPE -- iteration 3 of the federation-join-easy proof.
 *
 * The peer-exec relay fixes mixed-content, WireGuard-only peers, and
 * unified auth by making the local backend the trust gateway.
 *
 * Trust boundary:
 *   - Readonly commands (/dig, /trace, /recap, /standup): always permitted
 *   - Shell/write/mutate: require origin in config.wormhole.shellPeers
 *
 * Session cookie (Path B mitigation):
 *   Issues a localhost-only cookie on first request, verifies on subsequent calls.
 */

import { Elysia, t } from "elysia";
import { loadConfig } from "../config";
import { signHeaders } from "../lib/federation-auth";
import {
  setSessionCookie,
  hasValidSessionCookie,
  parseSignature,
  isReadOnlyCmd,
  isShellPeerAllowed,
  resolvePeerUrl,
} from "./peer-exec-auth";

export { parseSignature, isReadOnlyCmd, isShellPeerAllowed, resolvePeerUrl } from "./peer-exec-auth";

// --- Relay ---------------------------------------------------------------

export interface PeerExecRelayResult {
  output: string;
  from: string;
  elapsedMs: number;
  status: number;
}

export interface PeerExecRelayDeps {
  loadConfig?: typeof loadConfig;
  signHeaders?: typeof signHeaders;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function relayToPeer(
  peerUrl: string,
  body: { cmd: string; args: string[]; signature: string },
  deps: PeerExecRelayDeps = {},
): Promise<PeerExecRelayResult> {
  const load = deps.loadConfig ?? loadConfig;
  const sign = deps.signHeaders ?? signHeaders;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const start = now();
  const path = "/api/peer/exec";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const config = load() as any;
  const token = config?.federationToken;
  if (token) {
    Object.assign(headers, sign(token, "POST", path));
  }

  const response = await fetchImpl(`${peerUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return {
    output: text,
    from: peerUrl,
    elapsedMs: now() - start,
    status: response.status,
  };
}

// --- Route ---------------------------------------------------------------

export interface PeerExecApiDeps {
  setSessionCookie?: typeof setSessionCookie;
  hasValidSessionCookie?: typeof hasValidSessionCookie;
  parseSignature?: typeof parseSignature;
  isReadOnlyCmd?: typeof isReadOnlyCmd;
  isShellPeerAllowed?: typeof isShellPeerAllowed;
  resolvePeerUrl?: typeof resolvePeerUrl;
  relayToPeer?: typeof relayToPeer;
}

export function createPeerExecApi(deps: PeerExecApiDeps = {}) {
  const setCookie = deps.setSessionCookie ?? setSessionCookie;
  const hasValidCookie = deps.hasValidSessionCookie ?? hasValidSessionCookie;
  const parseSig = deps.parseSignature ?? parseSignature;
  const readOnlyCmd = deps.isReadOnlyCmd ?? isReadOnlyCmd;
  const shellAllowed = deps.isShellPeerAllowed ?? isShellPeerAllowed;
  const resolvePeer = deps.resolvePeerUrl ?? resolvePeerUrl;
  const relay = deps.relayToPeer ?? relayToPeer;

  const peerExecApi = new Elysia();

  peerExecApi.get("/peer/session", ({ set }) => {
    setCookie(set as any);
    return { ok: true, rotates: "on_server_restart" };
  });

  peerExecApi.post("/peer/exec", async ({ body, headers, set }) => {
    const { peer, cmd, args = [], signature } = body;

    if (!peer || !cmd || !signature) {
      set.status = 400; return { error: "missing_fields", required: ["peer", "cmd", "signature"] };
    }

    // 1. Parse signature
    const parsed = parseSig(signature);
    if (!parsed) {
      set.status = 400; return { error: "bad_signature", expected: "[host:agent]" };
    }

    // 2. Session cookie check
    // Bypass ONLY when explicitly in dev mode. Default (unset NODE_ENV) = secure.
    const devBypass = process.env.NODE_ENV === "development";
    if (!devBypass && !hasValidCookie(headers)) {
      set.status = 401; return { error: "no_session", hint: "GET /api/peer/session first" };
    }

    // 3 + 4. Trust boundary
    const readonly = readOnlyCmd(cmd);
    if (!readonly) {
      const allowed = shellAllowed(parsed.originHost);
      if (!allowed) {
        set.status = 403; return {
          error: "shell_peer_denied",
          origin: parsed.originHost,
          hint: parsed.isAnon
            ? "anonymous browser visitors are read-only; only /dig, /trace, /recap and similar work"
            : "add this origin to config.wormhole.shellPeers to permit shell cmds",
        };
      }
    }

    // 5. Resolve peer
    const peerUrl = resolvePeer(peer);
    if (!peerUrl) {
      set.status = 404; return { error: "unknown_peer", peer };
    }

    // 6 + 7. Relay and return
    try {
      const result = await relay(peerUrl, { cmd, args, signature });
      return {
        output: result.output,
        from: result.from,
        elapsed_ms: result.elapsedMs,
        status: result.status,
        trust_tier: readonly ? "readonly" : "shell_allowlisted",
      };
    } catch (err: any) {
      set.status = 502; return { error: "relay_failed", peer: peerUrl, reason: err?.message ?? String(err) };
    }
  }, {
    body: t.Object({
      peer: t.Optional(t.String()),
      cmd: t.Optional(t.String()),
      args: t.Optional(t.Array(t.String())),
      signature: t.Optional(t.String()),
    }),
  });

  return peerExecApi;
}

export const peerExecApi = createPeerExecApi();
