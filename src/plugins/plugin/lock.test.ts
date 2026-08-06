/**
 * plugins.lock — recordInstall() unit tests for #680 ask #1.
 *
 * Happy-path writer: every successful install stages a lock entry. Covers
 * idempotent re-install, --link entry shape, rejection of malformed input,
 * and preservation of `added` across updates.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLock, recordInstall, writeLock, LOCK_SCHEMA } from "./lock";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mawlock-"));
  process.env.MAW_PLUGINS_LOCK = join(tmp, "plugins.lock");
});

afterEach(() => {
  delete process.env.MAW_PLUGINS_LOCK;
  rmSync(tmp, { recursive: true, force: true });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("recordInstall — happy path", () => {
  it("creates plugins.lock on first call", () => {
    expect(existsSync(process.env.MAW_PLUGINS_LOCK!)).toBe(false);
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./health-1.0.0.tgz" });
    expect(existsSync(process.env.MAW_PLUGINS_LOCK!)).toBe(true);
  });

  it("persists sha256/source/version for tarball install", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./health-1.0.0.tgz" });
    const lock = readLock();
    expect(lock.schema).toBe(LOCK_SCHEMA);
    expect(lock.plugins.health).toMatchObject({
      version: "1.0.0",
      sha256: HASH_A,
      source: "./health-1.0.0.tgz",
    });
    expect(lock.plugins.health.linked).toBeUndefined();
    expect(typeof lock.plugins.health.added).toBe("string");
  });

  it("records linked=true + link: source for --link installs", () => {
    recordInstall({
      name: "health", version: "1.0.0", sha256: HASH_A,
      source: "link:/home/dev/health", linked: true,
    });
    const entry = readLock().plugins.health;
    expect(entry.linked).toBe(true);
    expect(entry.source).toBe("link:/home/dev/health");
  });

  it("omits linked field on non-link installs (not stored as false)", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./x.tgz" });
    const raw = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect("linked" in raw.plugins.health).toBe(false);
  });
});

describe("recordInstall — idempotency", () => {
  it("preserves `added` timestamp across re-install with new sha", async () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./v1.tgz" });
    const firstAdded = readLock().plugins.health.added;
    // Tick so any wall-clock-based update is visibly later.
    await new Promise(r => setTimeout(r, 5));
    recordInstall({ name: "health", version: "1.0.1", sha256: HASH_B, source: "./v2.tgz" });
    const after = readLock().plugins.health;
    expect(after.added).toBe(firstAdded);
    expect(after.version).toBe("1.0.1");
    expect(after.sha256).toBe(HASH_B);
    expect(after.source).toBe("./v2.tgz");
  });

  it("does not duplicate entries (map keyed by name)", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./v1.tgz" });
    recordInstall({ name: "health", version: "1.0.1", sha256: HASH_B, source: "./v2.tgz" });
    const lock = readLock();
    expect(Object.keys(lock.plugins)).toEqual(["health"]);
  });

  it("toggles linked flag when switching from --link to tarball", () => {
    recordInstall({
      name: "health", version: "1.0.0", sha256: HASH_A,
      source: "link:/home/dev/health", linked: true,
    });
    expect(readLock().plugins.health.linked).toBe(true);
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_B, source: "./health.tgz" });
    expect(readLock().plugins.health.linked).toBeUndefined();
  });

  it("coexists with other plugins untouched", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./h.tgz" });
    recordInstall({ name: "echo", version: "0.1.0", sha256: HASH_B, source: "./e.tgz" });
    const lock = readLock();
    expect(Object.keys(lock.plugins).sort()).toEqual(["echo", "health"]);
    expect(lock.plugins.health.sha256).toBe(HASH_A);
    expect(lock.plugins.echo.sha256).toBe(HASH_B);
  });
});

describe("recordInstall — validation", () => {
  it("rejects invalid name", () => {
    expect(() =>
      recordInstall({ name: "BadName", version: "1.0.0", sha256: HASH_A, source: "./x.tgz" }),
    ).toThrow(/invalid plugin name/);
  });

  it("rejects invalid sha256 (wrong length)", () => {
    expect(() =>
      recordInstall({ name: "health", version: "1.0.0", sha256: "abc123", source: "./x.tgz" }),
    ).toThrow(/invalid sha256/);
  });

  it("rejects empty version", () => {
    expect(() =>
      recordInstall({ name: "health", version: "", sha256: HASH_A, source: "./x.tgz" }),
    ).toThrow(/version required/);
  });

  it("rejects empty source", () => {
    expect(() =>
      recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "" }),
    ).toThrow(/source required/);
  });

  it("accepts sha256: prefix form", () => {
    recordInstall({
      name: "health", version: "1.0.0",
      sha256: `sha256:${HASH_A}`,
      source: "./x.tgz",
    });
    expect(readLock().plugins.health.sha256).toBe(`sha256:${HASH_A}`);
  });
});

describe("recordInstall — persistence + schema", () => {
  it("round-trips through JSON with correct schema version", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./x.tgz" });
    const raw = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(raw.schema).toBe(LOCK_SCHEMA);
    expect(typeof raw.updated).toBe("string");
    expect(raw.plugins.health.sha256).toBe(HASH_A);
  });

  it("merges into a pre-existing lock without wiping prior entries", () => {
    // Seed a lock the init-bootstrap agent would have written.
    writeLock({
      schema: LOCK_SCHEMA,
      updated: new Date().toISOString(),
      plugins: {
        preexisting: {
          version: "0.1.0",
          sha256: HASH_B,
          source: "./preexisting.tgz",
          added: "2026-04-01T00:00:00.000Z",
        },
      },
    });
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./h.tgz" });
    const lock = readLock();
    expect(Object.keys(lock.plugins).sort()).toEqual(["health", "preexisting"]);
    expect(lock.plugins.preexisting.added).toBe("2026-04-01T00:00:00.000Z");
  });

  it("survives reinstall after manual lockfile edit (re-validates schema)", () => {
    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./h.tgz" });
    // Operator hand-adds another entry.
    const raw = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    raw.plugins.manual = {
      version: "9.9.9", sha256: HASH_B, source: "./manual.tgz",
      added: "2026-04-01T00:00:00.000Z",
    };
    writeFileSync(process.env.MAW_PLUGINS_LOCK!, JSON.stringify(raw, null, 2));
    recordInstall({ name: "health", version: "1.0.1", sha256: HASH_B, source: "./h2.tgz" });
    const lock = readLock();
    expect(lock.plugins.manual).toBeDefined();
    expect(lock.plugins.health.version).toBe("1.0.1");
  });
});
