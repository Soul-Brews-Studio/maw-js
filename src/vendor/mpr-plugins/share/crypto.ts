import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const INFO = Buffer.from("maw-share-e2e/aes-256-gcm/v1", "utf8");
const SALT = Buffer.from("maw-share-e2e-hkdf-salt/v1", "utf8");
const FRAME_MAGIC = Buffer.from("MS1", "ascii");
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export type ShareEncryptionKey = Buffer;

export function mintShareSecret(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

export function hashShareSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function deriveShareKey(secret: string): ShareEncryptionKey {
  const ikm = Buffer.from(secret, "base64url");
  if (ikm.byteLength < KEY_BYTES) {
    throw new Error("encrypted share secret must be at least 256 bits");
  }
  return Buffer.from(hkdfSync("sha256", ikm, SALT, INFO, KEY_BYTES));
}

export function createFrameNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

export function encryptShareFrame(key: ShareEncryptionKey, plaintext: Uint8Array | string, counter: bigint): Uint8Array {
  const nonce = createFrameNonce(counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plain = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([FRAME_MAGIC, nonce, encrypted, tag]));
}

export function decryptShareFrame(key: ShareEncryptionKey, frame: Uint8Array): Uint8Array {
  const buf = Buffer.from(frame);
  if (buf.byteLength < FRAME_MAGIC.byteLength + NONCE_BYTES + 16) {
    throw new Error("encrypted share frame is too short");
  }
  if (!buf.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC)) {
    throw new Error("invalid encrypted share frame");
  }
  const nonceStart = FRAME_MAGIC.byteLength;
  const bodyStart = nonceStart + NONCE_BYTES;
  const tagStart = buf.byteLength - 16;
  const nonce = buf.subarray(nonceStart, bodyStart);
  const ciphertext = buf.subarray(bodyStart, tagStart);
  const tag = buf.subarray(tagStart);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

export function isEncryptedShareFrame(frame: Uint8Array): boolean {
  const buf = Buffer.from(frame);
  return buf.byteLength >= FRAME_MAGIC.byteLength && buf.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC);
}
