/**
 * Focused catch-branch coverage for federation-auth constant-time HMAC compares.
 *
 * The normal tests intentionally use real crypto; this isolated file loads the
 * target after replacing only timingSafeEqual so the defensive catch blocks are
 * executable without changing production exports.
 */
import { describe, expect, mock, test } from "bun:test";

const realCrypto = await import("crypto");
const realTimingSafeEqual = realCrypto.timingSafeEqual;
let throwTimingSafeEqual = false;

mock.module("crypto", () => ({
  ...realCrypto,
  timingSafeEqual: (...args: Parameters<typeof realCrypto.timingSafeEqual>) => {
    if (throwTimingSafeEqual) {
      throw new RangeError("synthetic timingSafeEqual failure");
    }
    return realTimingSafeEqual(...args);
  },
}));

const { sign, verify, verifyHmacSig } = await import("../../src/lib/federation-auth");

const TOKEN = "0123456789abcdef-federation-token";

describe("federation-auth HMAC compare catch branches", () => {
  test("verify returns false when timingSafeEqual throws despite matching hex length", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(TOKEN, "POST", "/api/send", timestamp);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    throwTimingSafeEqual = true;
    try {
      expect(verify(TOKEN, "POST", "/api/send", timestamp, signature)).toBe(false);
    } finally {
      throwTimingSafeEqual = false;
    }
  });

  test("verifyHmacSig returns false when timingSafeEqual throws despite matching hex length", () => {
    const payload = "POST:/api/send:1700000000::mawjs:white";
    const signature = realCrypto.createHmac("sha256", TOKEN).update(payload).digest("hex");

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    throwTimingSafeEqual = true;
    try {
      expect(verifyHmacSig(TOKEN, payload, signature)).toBe(false);
    } finally {
      throwTimingSafeEqual = false;
    }
  });
});
