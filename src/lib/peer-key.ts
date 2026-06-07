/**
 * peer-key.ts — Per-peer cryptographic identity (#804 Step 1).
 *
 * Each maw node holds a long-lived 32-byte secret stored at
 * the state-path `peer-key` (mode 0600), generated on first read. The hex
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
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawConfigPath, mawStatePath } from "../core/xdg";
import { info } from "../cli/verbosity";

/** Path to the persisted peer key (mode 0600). */
export function peerKeyFilePath(): string {
  return mawStatePath("peer-key");
}

function legacyPeerKeyFilePath(): string {
  return mawConfigPath("peer-key");
}

export const PEER_KEY_FILE = peerKeyFilePath();

let cachedKey: string | null = null;

/**
 * Resolve the peer key (hex-encoded).
 *
 * Precedence:
 *   1. MAW_PEER_KEY env var (operator override) — file is not read.
 *   2. State-path `peer-key` if it exists.
 *   3. Legacy config-path `peer-key`, copied forward to state on first read.
 *   4. Generate a fresh 32-byte (64-char hex) key, persist with mode 0600,
 *      and log a one-time creation notice.
 */
export function getPeerKey(): string {
  if (process.env.MAW_PEER_KEY) return process.env.MAW_PEER_KEY;
  if (cachedKey) return cachedKey;
  const peerKeyFile = peerKeyFilePath();
  const legacyPeerKeyFile = legacyPeerKeyFilePath();
  try {
    cachedKey = readFileSync(peerKeyFile, "utf-8").trim();
    if (cachedKey) return cachedKey;
  } catch {
    // file missing or unreadable — try legacy config path before generating
  }
  if (legacyPeerKeyFile !== peerKeyFile) {
    try {
      const legacyKey = readFileSync(legacyPeerKeyFile, "utf-8").trim();
      if (legacyKey) {
        mkdirSync(dirname(peerKeyFile), { recursive: true });
        writeFileSync(peerKeyFile, legacyKey, { mode: 0o600, flag: "w" });
        try { chmodSync(peerKeyFile, 0o600); } catch { /* best-effort */ }
        cachedKey = legacyKey;
        info(`[peer-key] migrated peer key → ${peerKeyFile} (mode 0600)`);
        return legacyKey;
      }
    } catch {
      // no legacy key — fall through to generate
    }
  }
  const fresh = randomBytes(32).toString("hex");
  mkdirSync(dirname(peerKeyFile), { recursive: true });
  writeFileSync(peerKeyFile, fresh, { mode: 0o600, flag: "w" });
  // chmod is a belt-and-suspenders for filesystems where the open-time mode
  // isn't honored (umask-stripped, NFS, etc).
  try { chmodSync(peerKeyFile, 0o600); } catch { /* best-effort */ }
  cachedKey = fresh;
  info(`[peer-key] generated random peer key → ${peerKeyFile} (mode 0600)`);
  return fresh;
}

/** Reset the in-memory key cache (test seam). */
export function resetPeerKeyCache(): void {
  cachedKey = null;
}
