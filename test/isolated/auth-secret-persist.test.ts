/**
 * auth-secret-persist.test.ts — #801.
 *
 * Pinpoint test: src/lib/auth.ts must NOT default to a predictable secret
 * (`"maw-" + node`). Instead, when MAW_JWT_SECRET is unset, the module
 * generates a 32-byte random secret on first call, persists it to
 * <CONFIG_DIR>/auth-secret with mode 0600, and reuses it across calls /
 * restarts (like SSH host keys).
 *
 * Isolated (per-file subprocess) because we mutate process.env.MAW_CONFIG_DIR
 * before the module import — and src/core/paths.ts captures CONFIG_DIR at
 * module-load time. Running this in the shared pool would either poison
 * sibling tests or get poisoned by them.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";

// ─── Pin CONFIG_DIR to a tmp dir BEFORE importing the target module ─────────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-auth-801-"));
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
// Ensure no operator override leaks into the test process.
delete process.env.MAW_JWT_SECRET;
delete process.env.MAW_HOME;

// Import after env is set so CONFIG_DIR resolves to TEST_CONFIG_DIR.
const auth = await import("../../src/lib/auth");
const { AUTH_SECRET_FILE, getJwtSecret, resetJwtSecretCache } = auth;

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts with a clean slate: no env override, no cached secret,
  // no on-disk file. The secret file's location is fixed per import — only
  // its presence/contents vary.
  delete process.env.MAW_JWT_SECRET;
  resetJwtSecretCache();
  if (existsSync(AUTH_SECRET_FILE)) rmSync(AUTH_SECRET_FILE, { force: true });
});

describe("getJwtSecret() — #801 random + persisted secret", () => {
  test("AUTH_SECRET_FILE resolves under the test CONFIG_DIR (env wiring sanity)", () => {
    expect(AUTH_SECRET_FILE).toBe(join(TEST_CONFIG_DIR, "auth-secret"));
  });

  test("missing file → creates 64-char hex secret and persists it", () => {
    expect(existsSync(AUTH_SECRET_FILE)).toBe(false);

    const secret = getJwtSecret();

    // 32 bytes hex-encoded == 64 chars, lowercase [0-9a-f].
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // File now exists with the same content.
    expect(existsSync(AUTH_SECRET_FILE)).toBe(true);
    expect(readFileSync(AUTH_SECRET_FILE, "utf-8")).toBe(secret);
  });

  test("missing file → file written with mode 0600 (owner-only)", () => {
    getJwtSecret();
    const st = statSync(AUTH_SECRET_FILE);
    // POSIX permission bits only — mask off file-type bits.
    const mode = st.mode & 0o777;
    if (platform() === "win32") {
      // Windows POSIX mode semantics differ; sanity-check the file exists.
      expect(existsSync(AUTH_SECRET_FILE)).toBe(true);
    } else {
      expect(mode).toBe(0o600);
    }
  });

  test("not predictable — old default `\"maw-\" + node` is gone", () => {
    const secret = getJwtSecret();
    expect(secret.startsWith("maw-")).toBe(false);
    expect(secret).not.toBe("maw-local");
  });

  test("existing file → reused as-is (no overwrite, no regeneration)", () => {
    const PRE_EXISTING = "a".repeat(64); // distinguishable from any random output
    writeFileSync(AUTH_SECRET_FILE, PRE_EXISTING, { mode: 0o600 });
    resetJwtSecretCache(); // force re-read

    const secret = getJwtSecret();

    expect(secret).toBe(PRE_EXISTING);
    // File contents must not have been overwritten.
    expect(readFileSync(AUTH_SECRET_FILE, "utf-8")).toBe(PRE_EXISTING);
  });

  test("two calls in the same process return the same value (cache + persistence)", () => {
    const a = getJwtSecret();
    const b = getJwtSecret();
    expect(a).toBe(b);
    // Cache invalidation also returns the SAME persisted secret (not a fresh one).
    resetJwtSecretCache();
    const c = getJwtSecret();
    expect(c).toBe(a);
  });

  test("MAW_JWT_SECRET env var → used directly, file is NOT created or read", () => {
    const ENV_SECRET = "env-override-secret-not-on-disk";
    process.env.MAW_JWT_SECRET = ENV_SECRET;
    expect(existsSync(AUTH_SECRET_FILE)).toBe(false);

    const secret = getJwtSecret();

    expect(secret).toBe(ENV_SECRET);
    // The presence of the env var must short-circuit before any file I/O.
    expect(existsSync(AUTH_SECRET_FILE)).toBe(false);
  });

  test("MAW_JWT_SECRET takes precedence even when an on-disk secret already exists", () => {
    const ON_DISK = "b".repeat(64);
    writeFileSync(AUTH_SECRET_FILE, ON_DISK, { mode: 0o600 });
    process.env.MAW_JWT_SECRET = "env-wins";
    resetJwtSecretCache();

    expect(getJwtSecret()).toBe("env-wins");
    // On-disk file must remain untouched.
    expect(readFileSync(AUTH_SECRET_FILE, "utf-8")).toBe(ON_DISK);
  });
});

describe("createToken / verifyToken — #801 round-trip with persisted secret", () => {
  test("token signed with persisted secret round-trips through verifyToken", () => {
    const tok = auth.createToken();
    const payload = auth.verifyToken(tok);
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  test("token signed under one secret does NOT verify under another", () => {
    const tok = auth.createToken();
    // Swap the on-disk secret + cache → verification must fail.
    rmSync(AUTH_SECRET_FILE, { force: true });
    writeFileSync(AUTH_SECRET_FILE, "c".repeat(64), { mode: 0o600 });
    resetJwtSecretCache();
    expect(auth.verifyToken(tok)).toBeNull();
  });
});
