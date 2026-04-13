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

import { Elysia, t} from "elysia";
import { randomBytes } from "crypto";
import { loadConfig } from "../config";
import { signHeaders } from "../lib/federation-auth";

// --- Session cookie (in-memory, rotates on server restart) ---------------

const PE_SESSION_TOKEN = randomBytes(16).toString("hex");
const PE_COOKIE_NAME = "pe_session";
const PE_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

function setSessionCookie(set: { headers: Record<string, string> }): void {
  set.headers["Set-Cookie"] =
    `${PE_COOKIE_NAME}=${PE_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/peer; Max-Age=${PE_COOKIE_MAX_AGE}`;
}

function hasValidSessionCookie(headers: Record<string, string | undefined>): boolean {
  const cookieHeader = headers["cookie"] || "";
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

export function resolvePeerUrl(peer: string): string | null {
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
  output: string;
  from: string;
  elapsedMs: number;
  status: number;
}

async function relayToPeer(
  peerUrl: string,
  body: { cmd: string; args: string[]; signature: string },
): Promise<RelayResult> {
  const start = Date.now();
  const path = "/api/peer/exec";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

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

export const peerExecApi = new Elysia();

peerExecApi.get("/peer/session", ({ set }) => {
  setSessionCookie(set as any);
  return { ok: true, rotates: "on_server_restart" };
});

peerExecApi.post("/peer/exec", async ({ body, headers, set}) => {
  const { peer, cmd, args = [], signature } = body;

  if (!peer || !cmd || !signature) {
    set.status = 400; return { error: "missing_fields", required: ["peer", "cmd", "signature"] };
  }

  // 1. Parse signature
  const parsed = parseSignature(signature);
  if (!parsed) {
    set.status = 400; return { error: "bad_signature", expected: "[host:agent]" };
  }

  // 2. Session cookie check
  const devBypass = process.env.NODE_ENV !== "production";
  if (!devBypass && !hasValidSessionCookie(headers)) {
    set.status = 401; return { error: "no_session", hint: "GET /api/peer/session first" };
  }

  // 3 + 4. Trust boundary
  const readonly = isReadOnlyCmd(cmd);
  if (!readonly) {
    const allowed = isShellPeerAllowed(parsed.originHost);
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
  const peerUrl = resolvePeerUrl(peer);
  if (!peerUrl) {
    set.status = 404; return { error: "unknown_peer", peer };
  }

  // 6 + 7. Relay and return
  try {
    const result = await relayToPeer(peerUrl, { cmd, args, signature });
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
