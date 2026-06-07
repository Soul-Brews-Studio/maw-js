import { describe, expect, test, beforeAll } from "bun:test";
import { Buffer } from "buffer";

process.env.MAW_JWT_SECRET = "auth-extra-secret";

let auth: typeof import("../../src/lib/auth");

function sign(data: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${process.env.MAW_JWT_SECRET}.${data}`);
  return hasher.digest("base64url");
}

beforeAll(async () => {
  auth = await import("../../src/lib/auth.ts?auth-extra-coverage");
});

describe("auth extra coverage", () => {
  test("extractToken prefers Bearer auth and falls back to query token", () => {
    expect(auth.extractToken(new Request("http://local/?token=query-token", { headers: { authorization: "Bearer header-token" } }))).toBe("header-token");
    expect(auth.extractToken(new Request("http://local/?token=query-token"))).toBe("query-token");
    expect(auth.extractToken(new Request("http://local/"))).toBeNull();
  });

  test("verifyToken rejects malformed, wrong-length, wrong-signature, bad-json, and expired tokens", () => {
    expect(auth.verifyToken("no-dot-token")).toBeNull();

    const goodData = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 1000, node: "local" })).toString("base64url");
    expect(auth.verifyToken(`${goodData}.short`)).toBeNull();
    expect(auth.verifyToken(`${goodData}.${"x".repeat(sign(goodData).length)}`)).toBeNull();

    const badJson = Buffer.from("not-json").toString("base64url");
    expect(auth.verifyToken(`${badJson}.${sign(badJson)}`)).toBeNull();

    const expiredData = Buffer.from(JSON.stringify({ iat: 1, exp: Date.now() - 1, node: "local" })).toString("base64url");
    expect(auth.verifyToken(`${expiredData}.${sign(expiredData)}`)).toBeNull();
  });

  test("createToken signs with env secret and verifyToken accepts the round trip", () => {
    const token = auth.createToken();
    const payload = auth.verifyToken(token);
    expect(payload?.node).toBeTruthy();
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });
});
