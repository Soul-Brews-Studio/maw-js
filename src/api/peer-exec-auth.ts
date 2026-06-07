/**
 * Auth, trust, and peer-URL helpers for the peer-exec relay.
 * Session cookie management + trust boundary enforcement.
 */

import { randomBytes } from "crypto";
import { loadConfig } from "../config";

// --- Session cookie (in-memory, rotates on server restart) ---------------

const PE_SESSION_TOKEN = randomBytes(16).toString("hex");
const PE_COOKIE_NAME = "pe_session";
const PE_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

export function setSessionCookie(set: { headers: Record<string, string> }): void {
  set.headers["Set-Cookie"] =
    `${PE_COOKIE_NAME}=${PE_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/peer; Max-Age=${PE_COOKIE_MAX_AGE}`;
}

export function hasValidSessionCookie(headers: Record<string, string | undefined>): boolean {
  const cookieHeader = headers["cookie"] || "";
  const match = cookieHeader.match(new RegExp(`${PE_COOKIE_NAME}=([a-f0-9]+)`));
  return match !== null && match[1] === PE_SESSION_TOKEN;
}

// --- Signature parsing ----------------------------------------------------

export interface ParsedSignature {
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

export interface PeerConfigDeps {
  loadConfig?: typeof loadConfig;
}

export function isShellPeerAllowed(originHost: string, deps: PeerConfigDeps = {}): boolean {
  if (originHost.startsWith("anon-")) return false;
  const readConfig = deps.loadConfig ?? loadConfig;
  const config = readConfig() as any;
  const allowed: string[] = config?.wormhole?.shellPeers ?? [];
  return allowed.includes(originHost);
}

// --- Peer URL resolution --------------------------------------------------

export function resolvePeerUrl(peer: string, deps: PeerConfigDeps = {}): string | null {
  const readConfig = deps.loadConfig ?? loadConfig;
  const config = readConfig() as any;
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const match = namedPeers.find((p) => p.name === peer);
  if (match) return match.url;

  if (/^[\w.-]+:\d+$/.test(peer)) return `http://${peer}`;
  if (peer.startsWith("http://") || peer.startsWith("https://")) return peer;

  return null;
}
