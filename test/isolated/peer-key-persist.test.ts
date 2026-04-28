/**
 * peer-key-persist.test.ts — #804 Step 1.
 *
 * Pinpoint test: src/lib/peer-key.ts mirrors the JWT-secret pattern (#801).
 * When MAW_PEER_KEY is unset, the module generates a 32-byte random key on
 * first call, persists it to <CONFIG_DIR>/peer-key with mode 0600, and reuses
 * it across calls / restarts (SSH host-key model).
 *
 * Isolated (per-file subprocess) because we mutate process.env.MAW_CONFIG_DIR
 * before the module import — and src/core/paths.ts captures CONFIG_DIR at
 * module-load time. Running this in the shared pool would either poison
 * sibling tests or get poisoned by them.
 */
import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";

// ─── Pin CONFIG_DIR to a tmp dir BEFORE importing the target module ─────────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-peer-key-804-"));
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
// Ensure no operator override leaks into the test process.
delete process.env.MAW_PEER_KEY;
delete process.env.MAW_HOME;

// Import after env is set so CONFIG_DIR resolves to TEST_CONFIG_DIR.
const peerKey = await import("../../src/lib/peer-key");
const { PEER_KEY_FILE, getPeerKey, resetPeerKeyCache } = peerKey;

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts with a clean slate: no env override, no cached key,
  // no on-disk file.
  delete process.env.MAW_PEER_KEY;
  resetPeerKeyCache();
  if (existsSync(PEER_KEY_FILE)) rmSync(PEER_KEY_FILE, { force: true });
});

describe("getPeerKey() — #804 random + persisted peer key", () => {
  test("PEER_KEY_FILE resolves under the test CONFIG_DIR (env wiring sanity)", () => {
    expect(PEER_KEY_FILE).toBe(join(TEST_CONFIG_DIR, "peer-key"));
  });

  test("missing file → creates 64-char hex key and persists it", () => {
    expect(existsSync(PEER_KEY_FILE)).toBe(false);

    const key = getPeerKey();

    // 32 bytes hex-encoded == 64 chars, lowercase [0-9a-f].
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // File now exists with the same content.
    expect(existsSync(PEER_KEY_FILE)).toBe(true);
    expect(readFileSync(PEER_KEY_FILE, "utf-8")).toBe(key);
  });

  test("missing file → file written with mode 0600 (owner-only)", () => {
    getPeerKey();
    const st = statSync(PEER_KEY_FILE);
    // POSIX permission bits only — mask off file-type bits.
    const mode = st.mode & 0o777;
    if (platform() === "win32") {
      // Windows POSIX mode semantics differ; sanity-check the file exists.
      expect(existsSync(PEER_KEY_FILE)).toBe(true);
    } else {
      expect(mode).toBe(0o600);
    }
  });

  test("existing file → reused as-is (no overwrite, no regeneration)", () => {
    const PRE_EXISTING = "d".repeat(64); // distinguishable from any random output
    writeFileSync(PEER_KEY_FILE, PRE_EXISTING, { mode: 0o600 });
    resetPeerKeyCache(); // force re-read

    const key = getPeerKey();

    expect(key).toBe(PRE_EXISTING);
    // File contents must not have been overwritten.
    expect(readFileSync(PEER_KEY_FILE, "utf-8")).toBe(PRE_EXISTING);
  });

  test("two calls in the same process return the same value (cache + persistence)", () => {
    const a = getPeerKey();
    const b = getPeerKey();
    expect(a).toBe(b);
    // Cache invalidation also returns the SAME persisted key (not a fresh one).
    resetPeerKeyCache();
    const c = getPeerKey();
    expect(c).toBe(a);
  });

  test("MAW_PEER_KEY env var → used directly, file is NOT created or read", () => {
    const ENV_KEY = "env-override-peer-key-not-on-disk";
    process.env.MAW_PEER_KEY = ENV_KEY;
    expect(existsSync(PEER_KEY_FILE)).toBe(false);

    const key = getPeerKey();

    expect(key).toBe(ENV_KEY);
    // The presence of the env var must short-circuit before any file I/O.
    expect(existsSync(PEER_KEY_FILE)).toBe(false);
  });

  test("MAW_PEER_KEY takes precedence even when an on-disk key already exists", () => {
    const ON_DISK = "e".repeat(64);
    writeFileSync(PEER_KEY_FILE, ON_DISK, { mode: 0o600 });
    process.env.MAW_PEER_KEY = "env-wins";
    resetPeerKeyCache();

    expect(getPeerKey()).toBe("env-wins");
    // On-disk file must remain untouched.
    expect(readFileSync(PEER_KEY_FILE, "utf-8")).toBe(ON_DISK);
  });

  test("two distinct fresh keys in two processes differ (randomness sanity)", () => {
    // First fresh key.
    const k1 = getPeerKey();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    // Wipe everything and regenerate — must be different (cryptographic random).
    rmSync(PEER_KEY_FILE, { force: true });
    resetPeerKeyCache();
    const k2 = getPeerKey();
    expect(k2).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).not.toBe(k1);
  });
});
