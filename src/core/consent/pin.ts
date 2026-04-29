/**
 * PIN generation + hashing for the consent primitive (#644 Phase 1).
 *
 * Reuses the pair-code 6-char ALPHABET (no I/O/0/1/l) so users see
 * one shape across pair + consent surfaces. Hashing is SHA-256;
 * pending-store on disk holds the hash, never the plaintext, so
 * filesystem read access doesn't grant approval power.
 */
import { createHash } from "crypto";
import { generateCode, isValidShape, normalize, pretty } from "../../lib/pair-codes";

export function generatePin(): string {
  return generateCode();
}

export function hashPin(pin: string): string {
  return createHash("sha256").update(normalize(pin)).digest("hex");
}

export function verifyPin(pin: string, expectedHash: string): boolean {
  if (!isValidShape(pin)) return false;
  return hashPin(pin) === expectedHash;
}

export { isValidShape, normalize, pretty };
