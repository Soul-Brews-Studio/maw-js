/**
 * peer-key.ts — Per-peer cryptographic identity (#804 Step 1).
 *
 * Each maw node holds a long-lived 32-byte secret stored at
 * `<CONFIG_DIR>/peer-key` (mode 0600), generated on first read. The hex
 * encoding of this secret is published via `/api/identity` as `pubkey` so
 * peers can pin it under TOFU (see ADR docs/federation/0001-peer-identity.md).
 *
 * Step 1 only persists + advertises the key. Signing + verification (Step 4)
 * will derive an Ed25519 keypair from this seed; for now we treat the hex
 * string as the published "pubkey" identifier — same persistence model, same
 * lifecycle. Rotation is operator-driven (`maw peers forget`).
 *
 * Mirrors src/lib/auth.ts (#801) deliberately: env override, persistent file,
 * mode 0600, in-process cache. Two cousin modules → one pattern.
 */

import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/paths";
import { info } from "../cli/verbosity";

/** Path to the persisted peer key (mode 0600). */
export const PEER_KEY_FILE = join(CONFIG_DIR, "peer-key");

let cachedKey: string | null = null;

/**
 * Resolve the peer key (hex-encoded).
 *
 * Precedence:
 *   1. MAW_PEER_KEY env var (operator override) — file is not read.
 *   2. <CONFIG_DIR>/peer-key if it exists.
 *   3. Generate a fresh 32-byte (64-char hex) key, persist with mode 0600,
 *      and log a one-time creation notice.
 */
export function getPeerKey(): string {
  if (process.env.MAW_PEER_KEY) return process.env.MAW_PEER_KEY;
  if (cachedKey) return cachedKey;
  try {
    cachedKey = readFileSync(PEER_KEY_FILE, "utf-8").trim();
    if (cachedKey) return cachedKey;
  } catch {
    // file missing or unreadable — fall through to generate
  }
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(PEER_KEY_FILE, fresh, { mode: 0o600, flag: "w" });
  // chmod is a belt-and-suspenders for filesystems where the open-time mode
  // isn't honored (umask-stripped, NFS, etc).
  try { chmodSync(PEER_KEY_FILE, 0o600); } catch { /* best-effort */ }
  cachedKey = fresh;
  info(`[peer-key] generated random peer key → ${PEER_KEY_FILE} (mode 0600)`);
  return fresh;
}

/** Reset the in-memory key cache (test seam). */
export function resetPeerKeyCache(): void {
  cachedKey = null;
}
