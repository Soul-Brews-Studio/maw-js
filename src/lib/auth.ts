/**
 * JWT Auth for MAW Dashboard Pro.
 *
 * Flow: PIN verify → JWT token → use token for subsequent requests.
 * Tokens expire after 24h. Refresh by re-verifying PIN.
 */

import { loadConfig } from "../config";

const JWT_SECRET = process.env.MAW_JWT_SECRET || "maw-dashboard-pro-" + (loadConfig() as any).pin || "default";
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

interface TokenPayload {
  iat: number;
  exp: number;
  role: "admin";
}

/** Simple HMAC-based token (no external deps) */
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
    role: "admin",
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
  const expected = hmacSign(data);
  if (sig !== expected) return null;

  try {
    const payload: TokenPayload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract token from request (header or query param) */
export function extractToken(req: Request): string | null {
  // Authorization: Bearer <token>
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  // Query param: ?token=<token> (for WebSocket)
  const url = new URL(req.url);
  return url.searchParams.get("token");
}
