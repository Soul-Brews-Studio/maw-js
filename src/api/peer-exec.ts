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
import { pushFeedEvent } from "./feed";
import {
  buildWormholeLifecycleFeedEvent,
  type WormholeLifecycleInput,
} from "../lib/wormhole-events";
import {
  setSessionCookie,
  hasValidSessionCookie,
  parseSignature,
  isReadOnlyCmd,
  isShellPeerAllowed,
  resolvePeerUrl,
} from "./peer-exec-auth";

export { parseSignature, isReadOnlyCmd, isShellPeerAllowed, resolvePeerUrl } from "./peer-exec-auth";

// Lifecycle emit — mirrors sessions.ts:emitMessageLifecycle. Server-side path:
// builds a FeedEvent and pushes through the in-process feedListeners ring so
// installed plugins see WormholeRequest / WormholeFail events alongside the
// existing MessageSend / MessageDeliver / MessageFail family.
export function emitWormholeLifecycle(input: WormholeLifecycleInput, deps: PeerExecApiDeps = {}) {
  try {
    const build = deps.buildWormholeLifecycleFeedEvent ?? buildWormholeLifecycleFeedEvent;
    const push = deps.pushFeedEvent ?? pushFeedEvent;
    push(build(input));
  } catch {
    // Hook errors must never change /api/peer/exec response semantics.
  }
}

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
  pushFeedEvent?: typeof pushFeedEvent;
  buildWormholeLifecycleFeedEvent?: typeof buildWormholeLifecycleFeedEvent;
  emitWormholeLifecycle?: (input: WormholeLifecycleInput) => void;
}

export function createPeerExecApi(deps: PeerExecApiDeps = {}) {
  const setCookie = deps.setSessionCookie ?? setSessionCookie;
  const hasValidCookie = deps.hasValidSessionCookie ?? hasValidSessionCookie;
  const parseSig = deps.parseSignature ?? parseSignature;
  const readOnlyCmd = deps.isReadOnlyCmd ?? isReadOnlyCmd;
  const shellAllowed = deps.isShellPeerAllowed ?? isShellPeerAllowed;
  const resolvePeer = deps.resolvePeerUrl ?? resolvePeerUrl;
  const relay = deps.relayToPeer ?? relayToPeer;
  const emitLifecycle = deps.emitWormholeLifecycle ?? ((input: WormholeLifecycleInput) => emitWormholeLifecycle(input, deps));

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

    const origin = `[${parsed.originHost}:${parsed.originAgent}]`;

    // 2. Session cookie check
    // Bypass ONLY when explicitly in dev mode. Default (unset NODE_ENV) = secure.
    const devBypass = process.env.NODE_ENV === "development";
    if (!devBypass && !hasValidCookie(headers)) {
      emitLifecycle({
        direction: "relayed", state: "failed",
        cmd, args, origin, peer, trustTier: "denied",
        status: 401, error: "no_session",
      });
      set.status = 401; return { error: "no_session", hint: "GET /api/peer/session first" };
    }

    // 3 + 4. Trust boundary
    const readonly = readOnlyCmd(cmd);
    if (!readonly) {
      const allowed = shellAllowed(parsed.originHost);
      if (!allowed) {
        emitLifecycle({
          direction: "relayed", state: "failed",
          cmd, args, origin, peer, trustTier: "denied",
          status: 403, error: "shell_peer_denied",
        });
        set.status = 403; return {
          error: "shell_peer_denied",
          origin: parsed.originHost,
          hint: parsed.isAnon
            ? "anonymous browser visitors are read-only; only /dig, /trace, /recap and similar work"
            : "add this origin to config.wormhole.shellPeers to permit shell cmds",
        };
      }
    }

    const trustTier = readonly ? "readonly" : "shell_allowlisted";

    // 5. Resolve peer
    const peerUrl = resolvePeer(peer);
    if (!peerUrl) {
      emitLifecycle({
        direction: "relayed", state: "failed",
        cmd, args, origin, peer, trustTier,
        status: 404, error: "unknown_peer",
      });
      set.status = 404; return { error: "unknown_peer", peer };
    }

    // 6 + 7. Relay and return
    try {
      const result = await relay(peerUrl, { cmd, args, signature });
      const peerFailed = result.status >= 400;
      emitLifecycle({
        direction: "relayed", state: peerFailed ? "failed" : "delivered",
        cmd, args, origin, peer, peerUrl, trustTier,
        elapsedMs: result.elapsedMs,
        status: result.status,
        outputBytes: new TextEncoder().encode(result.output).byteLength,
        ...(peerFailed ? { error: `peer_status_${result.status}` } : {}),
      });
      return {
        output: result.output,
        from: result.from,
        elapsed_ms: result.elapsedMs,
        status: result.status,
        trust_tier: trustTier,
      };
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      emitLifecycle({
        direction: "relayed", state: "failed",
        cmd, args, origin, peer, peerUrl, trustTier,
        status: 502, error: reason,
      });
      set.status = 502; return { error: "relay_failed", peer: peerUrl, reason };
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
