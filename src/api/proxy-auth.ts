// Proxy API — session cookie management and signature parsing

import { randomBytes } from "crypto";

// --- Session cookie (in-memory, rotates on server restart) ---------------

export const PROXY_SESSION_TOKEN = randomBytes(16).toString("hex");
export const PROXY_COOKIE_NAME = "proxy_session";
export const PROXY_COOKIE_MAX_AGE = 60 * 60 * 24;

export function setProxySessionCookie(set: { headers: Record<string, string> }): void {
  set.headers["Set-Cookie"] =
    `${PROXY_COOKIE_NAME}=${PROXY_SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/proxy; Max-Age=${PROXY_COOKIE_MAX_AGE}`;
}

export function hasValidProxySessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${PROXY_COOKIE_NAME}=([a-f0-9]+)`));
  return match !== null && match[1] === PROXY_SESSION_TOKEN;
}

// --- Signature parsing (local copy — not shared with wormhole) -----------

// The signature shape is the same as /wormhole but parsed locally to avoid
// coupling the two files. If we ever share this, it should move to
// src/lib/signature.ts with explicit test coverage on BOTH consumers.

export interface ParsedSignature {
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
