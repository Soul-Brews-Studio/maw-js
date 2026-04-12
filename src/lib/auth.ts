/**
 * API token auth — lightweight HMAC-based tokens, zero external deps.
 *
 * Flow: PIN verify → createToken() → Bearer token → 24h expiry
 * Cherry-picked from natman95's PR #188 (Dashboard Pro).
 *
 * Uses Bun.CryptoHasher for HMAC — no jsonwebtoken, no jose, no deps.
 */

import { loadConfig } from "../config";

const JWT_SECRET = process.env.MAW_JWT_SECRET || "maw-" + ((loadConfig() as any).node || "local");
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

interface TokenPayload {
  iat: number;
  exp: number;
  node: string;
}

/** HMAC-SHA256 sign a payload string */
function hmacSign(payload: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JWT_SECRET + "." + payload);
  return hasher.digest("base64url");
}

/** Create a token after PIN verification */
export function createToken(): string {
  const payload: TokenPayload = {
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY,
    node: (loadConfig() as any).node || "local",
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(data);
  return `${data}.${sig}`;
}

/** Verify a token — returns payload or null */
export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (sig !== hmacSign(data)) return null;
  try {
    const payload: TokenPayload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract token from request (Bearer header or ?token= query param) */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(req.url);
  return url.searchParams.get("token");
}
