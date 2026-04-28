/**
 * API token auth — lightweight HMAC-based tokens, zero external deps.
 *
 * Flow: PIN verify → createToken() → Bearer token → 24h expiry
 * Cherry-picked from natman95's PR #188 (Dashboard Pro).
 *
 * Uses Bun.CryptoHasher for HMAC — no jsonwebtoken, no jose, no deps.
 *
 * Security:
 *   - Signature comparison is constant-time via crypto.timingSafeEqual (#800)
 *   - Secret resolution: when MAW_JWT_SECRET is unset, generate a 32-byte
 *     random secret on first run + persist to <CONFIG_DIR>/auth-secret
 *     (mode 0600), like SSH host keys. (#801)
 *
 * Cousin module src/lib/federation-auth.ts uses the same patterns.
 */

import { timingSafeEqual, randomBytes } from "crypto";
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/paths";
import { info } from "../cli/verbosity";
import { loadConfig } from "../config";

const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/** Path to the persisted random secret (mode 0600). */
export const AUTH_SECRET_FILE = join(CONFIG_DIR, "auth-secret");

let cachedSecret: string | null = null;

/**
 * Resolve the JWT/HMAC secret.
 *
 * Precedence:
 *   1. MAW_JWT_SECRET env var (operator override) — file is not read.
 *   2. <CONFIG_DIR>/auth-secret if it exists.
 *   3. Generate a fresh 32-byte (64-char hex) secret, persist with mode 0600,
 *      and log a one-time creation notice.
 */
export function getJwtSecret(): string {
  if (process.env.MAW_JWT_SECRET) return process.env.MAW_JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = readFileSync(AUTH_SECRET_FILE, "utf-8").trim();
    if (cachedSecret) return cachedSecret;
  } catch {
    // file missing or unreadable — fall through to generate
  }
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(AUTH_SECRET_FILE, fresh, { mode: 0o600, flag: "w" });
  // chmod is a belt-and-suspenders for filesystems where the open-time mode
  // isn't honored (umask-stripped, NFS, etc).
  try { chmodSync(AUTH_SECRET_FILE, 0o600); } catch { /* best-effort */ }
  cachedSecret = fresh;
  info(`[auth] generated random JWT secret → ${AUTH_SECRET_FILE} (mode 0600)`);
  return fresh;
}

/** Reset the in-memory secret cache (test seam). */
export function resetJwtSecretCache(): void {
  cachedSecret = null;
}

interface TokenPayload {
  iat: number;
  exp: number;
  node: string;
}

/** HMAC-SHA256 sign a payload string */
function hmacSign(payload: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(getJwtSecret() + "." + payload);
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
  // #800: constant-time signature comparison to prevent timing-channel
  // byte-by-byte recovery. Length-check first because timingSafeEqual
  // throws on length mismatch.
  const expected = Buffer.from(hmacSign(data));
  const provided = Buffer.from(sig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
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
