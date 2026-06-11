import { describe, expect, test } from "bun:test";

import {
  createFrameNonce,
  decryptShareFrame,
  deriveShareKey,
  encryptShareFrame,
  hashShareSecret,
  isEncryptedShareFrame,
  mintShareSecret,
} from "../src/vendor/mpr-plugins/share/crypto";
import { createShare, type Share } from "../src/vendor/mpr-plugins/share/impl";
import { attach } from "../src/vendor/mpr-plugins/share/stream";

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(text: string): Uint8Array {
  return enc.encode(text);
}

function nonceHex(frame: Uint8Array): string {
  // Frame envelope is "MS1" + 12-byte nonce + ciphertext + 16-byte tag.
  return Buffer.from(frame.slice(3, 15)).toString("hex");
}

function framePayload(frame: Uint8Array): string {
  return Buffer.from(frame).toString("latin1");
}

describe("share crypto hardening", () => {
  test("HKDF is deterministic for the same secret", () => {
    const secret = mintShareSecret();
    const keyA = deriveShareKey(secret);
    const keyB = deriveShareKey(secret);

    expect(keyA.byteLength).toBe(32);
    expect(keyB.byteLength).toBe(32);
    expect(Buffer.from(keyA).equals(Buffer.from(keyB))).toBe(true);
    expect(hashShareSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("AES-256-GCM roundtrips multiple frames with monotonic nonces", () => {
    const key = deriveShareKey(mintShareSecret());
    const plaintexts = [
      "first terminal frame\n",
      "second terminal frame with ansi \u001b[31mred\u001b[0m\n",
      bytes("third binary-ish frame \0\1\2\n"),
    ];

    const frames = plaintexts.map((plain, index) => encryptShareFrame(key, plain, BigInt(index)));

    expect(frames.every((frame) => isEncryptedShareFrame(frame))).toBe(true);
    expect(new Set(frames.map(nonceHex)).size).toBe(frames.length);
    expect(nonceHex(frames[0]!)).toBe(Buffer.from(createFrameNonce(0n)).toString("hex"));
    expect(nonceHex(frames[1]!)).toBe(Buffer.from(createFrameNonce(1n)).toString("hex"));
    expect(nonceHex(frames[2]!)).toBe(Buffer.from(createFrameNonce(2n)).toString("hex"));

    expect(dec.decode(decryptShareFrame(key, frames[0]!))).toBe(plaintexts[0]);
    expect(dec.decode(decryptShareFrame(key, frames[1]!))).toBe(plaintexts[1]);
    expect(Buffer.from(decryptShareFrame(key, frames[2]!)).equals(Buffer.from(plaintexts[2] as Uint8Array))).toBe(true);
  });

  test("tampered ciphertext and wrong keys fail authentication", () => {
    const key = deriveShareKey(mintShareSecret());
    const frame = encryptShareFrame(key, "auth-protected payload", 7n);

    const tampered = new Uint8Array(frame);
    tampered[tampered.length - 17] ^= 0xff;
    expect(() => decryptShareFrame(key, tampered)).toThrow();

    const wrongKey = deriveShareKey(mintShareSecret());
    expect(() => decryptShareFrame(wrongKey, frame)).toThrow();
  });

  test("encrypted stream snapshots and live frames decrypt and never expose plaintext ciphertext", async () => {
    const created = await createShare({ target: "session:0", auth: "encrypted", encrypted: true, ttl: 60 });
    const share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "token-hash-not-used-by-stream",
      expiresAt: Date.now() + 60_000,
      auth: "encrypted",
      encrypted: true,
      encryptionKey: deriveShareKey(created.token),
      encryptionKeyHash: hashShareSecret(created.token),
      encryptionFrameCounter: 0n,
    } satisfies Share;

    const sent: Array<string | Uint8Array> = [];
    const pipeCalls: unknown[][] = [];
    const killCalls: unknown[] = [];
    let childResolve: (() => void) | null = null;

    const handle = await attach(
      share,
      { send: (data: string | Uint8Array) => sent.push(data) } as any,
      {
        tmux: {
          capture: async () => "SNAPSHOT-SECRET\n",
          pipePane: async (...args: unknown[]) => {
            pipeCalls.push(args);
          },
        },
        spawnTail: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
          onChunk(bytes("LIVE-SECRET-1\n"));
          onChunk(bytes("LIVE-SECRET-2\n"));
          return {
            kill: (signal?: string | number) => killCalls.push(signal),
            exited: new Promise((resolve) => {
              childResolve = resolve;
            }),
          };
        },
      } as any,
    );

    expect(sent).toHaveLength(3);
    expect(sent.every((frame) => frame instanceof Uint8Array)).toBe(true);

    const encryptedFrames = sent as Uint8Array[];
    expect(new Set(encryptedFrames.map(nonceHex)).size).toBe(encryptedFrames.length);
    expect(encryptedFrames.map(nonceHex)).toEqual([
      Buffer.from(createFrameNonce(0n)).toString("hex"),
      Buffer.from(createFrameNonce(1n)).toString("hex"),
      Buffer.from(createFrameNonce(2n)).toString("hex"),
    ]);

    for (const frame of encryptedFrames) {
      expect(isEncryptedShareFrame(frame)).toBe(true);
      const wire = framePayload(frame);
      expect(wire).not.toContain("SNAPSHOT-SECRET");
      expect(wire).not.toContain("LIVE-SECRET");
    }

    const key = deriveShareKey(created.token);
    expect(dec.decode(decryptShareFrame(key, encryptedFrames[0]!))).toBe("SNAPSHOT-SECRET\n");
    expect(dec.decode(decryptShareFrame(key, encryptedFrames[1]!))).toBe("LIVE-SECRET-1\n");
    expect(dec.decode(decryptShareFrame(key, encryptedFrames[2]!))).toBe("LIVE-SECRET-2\n");
    expect(share.encryptionFrameCounter).toBe(3n);

    await handle.close();
    childResolve?.();

    expect(pipeCalls.some((call) => call[0] === "session:0" && call.length === 1)).toBe(true);
    expect(killCalls.length).toBeGreaterThan(0);
  });
});
