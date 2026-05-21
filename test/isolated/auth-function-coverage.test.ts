import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_CONFIG_DIR = join(tmpdir(), `maw-auth-function-${process.pid}`);
const TEST_STATE_DIR = join(tmpdir(), `maw-auth-function-state-${process.pid}`);
rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
rmSync(TEST_STATE_DIR, { recursive: true, force: true });
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
mkdirSync(TEST_STATE_DIR, { recursive: true });
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_STATE_DIR = TEST_STATE_DIR;
process.env.MAW_TEST_MODE = "1";
delete process.env.MAW_HOME;

const auth = await import("../../src/lib/auth.ts?function-coverage");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  auth.resetJwtSecretCache();
  rmSync(auth.AUTH_SECRET_FILE, { force: true });
  delete process.env.MAW_JWT_SECRET;
});

describe("auth function coverage", () => {
  test("resolves env, generated, cached, and file-backed secrets", () => {
    process.env.MAW_JWT_SECRET = "env-secret";
    expect(auth.getJwtSecret()).toBe("env-secret");

    delete process.env.MAW_JWT_SECRET;
    auth.resetJwtSecretCache();
    const generated = auth.getJwtSecret();
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.getJwtSecret()).toBe(generated);

    auth.resetJwtSecretCache();
    expect(auth.getJwtSecret()).toBe(generated);
  });

  test("creates, verifies, rejects, and extracts tokens", () => {
    process.env.MAW_JWT_SECRET = "token-secret";
    const token = auth.createToken();
    expect(auth.verifyToken(token)?.node).toBeTruthy();
    expect(auth.verifyToken("not.a.valid.token")).toBeNull();
    expect(auth.verifyToken(`${token.split(".")[0]}.bad-signature`)).toBeNull();

    expect(auth.extractToken(new Request("http://local/?token=q", { headers: { authorization: "Bearer h" } }))).toBe("h");
    expect(auth.extractToken(new Request("http://local/?token=q"))).toBe("q");
    expect(auth.extractToken(new Request("http://local/"))).toBeNull();
  });
});
