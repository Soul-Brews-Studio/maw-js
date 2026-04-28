/**
 * Tests for src/commands/plugins/plugin/lock.ts — validateSha256, validateName, validateSchema,
 * readLock/writeLock with MAW_PLUGINS_LOCK env override.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateSha256,
  validateName,
  validateSchema,
  LOCK_SCHEMA,
  readLock,
  writeLock,
  lockPath,
  recordInstall,
  unpinPlugin,
} from "../../src/commands/plugins/plugin/lock";

describe("validateSha256", () => {
  const valid = "a".repeat(64);

  it("accepts 64 lowercase hex chars", () => {
    expect(validateSha256(valid).ok).toBe(true);
  });

  it("accepts sha256:-prefixed hex", () => {
    expect(validateSha256(`sha256:${valid}`).ok).toBe(true);
  });

  it("rejects too short", () => {
    expect(validateSha256("abc123").ok).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(validateSha256("A".repeat(64)).ok).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateSha256("").ok).toBe(false);
  });

  it("rejects non-hex chars", () => {
    expect(validateSha256("g".repeat(64)).ok).toBe(false);
  });
});

describe("validateName", () => {
  it("accepts simple name", () => {
    expect(validateName("my-plugin").ok).toBe(true);
  });

  it("accepts name with dots", () => {
    expect(validateName("my.plugin").ok).toBe(true);
  });

  it("accepts name with slashes (scoped)", () => {
    expect(validateName("org/my-plugin").ok).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateName("").ok).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(validateName("MyPlugin").ok).toBe(false);
  });

  it("rejects starting with hyphen", () => {
    expect(validateName("-bad").ok).toBe(false);
  });

  it("rejects too long (129 chars)", () => {
    expect(validateName("a".repeat(129)).ok).toBe(false);
  });

  it("accepts max length (128 chars)", () => {
    expect(validateName("a".repeat(128)).ok).toBe(true);
  });
});

describe("validateSchema", () => {
  it("accepts valid lock structure", () => {
    const parsed = {
      schema: LOCK_SCHEMA,
      updated: "2026-01-01",
      plugins: {
        "my-plugin": {
          version: "1.0.0",
          sha256: "a".repeat(64),
          source: "http://example.com/plugin.tgz",
          added: "2026-01-01",
        },
      },
    };
    const result = validateSchema(parsed);
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    expect(validateSchema(null).ok).toBe(false);
  });

  it("rejects non-object", () => {
    expect(validateSchema("string").ok).toBe(false);
  });

  it("rejects missing schema field", () => {
    expect(validateSchema({ plugins: {} }).ok).toBe(false);
  });

  it("rejects unknown schema version", () => {
    const result = validateSchema({ schema: 999, plugins: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown schema");
  });

  it("rejects non-object plugins", () => {
    expect(validateSchema({ schema: LOCK_SCHEMA, plugins: [] }).ok).toBe(false);
  });

  it("rejects entry missing version", () => {
    const result = validateSchema({
      schema: LOCK_SCHEMA,
      plugins: { "test": { sha256: "a".repeat(64), source: "x" } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects entry with invalid sha256", () => {
    const result = validateSchema({
      schema: LOCK_SCHEMA,
      plugins: { "test": { version: "1.0.0", sha256: "bad", source: "x" } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects entry missing source", () => {
    const result = validateSchema({
      schema: LOCK_SCHEMA,
      plugins: { "test": { version: "1.0.0", sha256: "a".repeat(64) } },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts empty plugins object", () => {
    const result = validateSchema({ schema: LOCK_SCHEMA, plugins: {} });
    expect(result.ok).toBe(true);
  });

  it("preserves linked flag", () => {
    const result = validateSchema({
      schema: LOCK_SCHEMA,
      plugins: {
        "test": { version: "1.0.0", sha256: "a".repeat(64), source: "link:/path", linked: true },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lock.plugins.test.linked).toBe(true);
  });

  it("preserves signers array", () => {
    const result = validateSchema({
      schema: LOCK_SCHEMA,
      plugins: {
        "test": { version: "1.0.0", sha256: "a".repeat(64), source: "x", signers: ["alice"] },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lock.plugins.test.signers).toEqual(["alice"]);
  });
});

describe("readLock / writeLock with MAW_PLUGINS_LOCK", () => {
  let tmp: string;
  let lockFile: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    lockFile = join(tmp, "plugins.lock");
    origEnv = process.env.MAW_PLUGINS_LOCK;
    process.env.MAW_PLUGINS_LOCK = lockFile;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MAW_PLUGINS_LOCK;
    else process.env.MAW_PLUGINS_LOCK = origEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lockPath uses env override", () => {
    expect(lockPath()).toBe(lockFile);
  });

  it("readLock returns empty lock when file missing", () => {
    const lock = readLock();
    expect(lock.schema).toBe(LOCK_SCHEMA);
    expect(lock.plugins).toEqual({});
  });

  it("writeLock creates file", () => {
    const lock = { schema: LOCK_SCHEMA, updated: "", plugins: {} };
    writeLock(lock);
    const raw = readFileSync(lockFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.schema).toBe(LOCK_SCHEMA);
  });

  it("round-trips lock data", () => {
    const lock = {
      schema: LOCK_SCHEMA,
      updated: "2026-01-01",
      plugins: {
        "test-plugin": {
          version: "1.0.0",
          sha256: "a".repeat(64),
          source: "http://example.com/test.tgz",
          added: "2026-01-01",
        },
      },
    };
    writeLock(lock);
    const loaded = readLock();
    expect(loaded.plugins["test-plugin"].version).toBe("1.0.0");
    expect(loaded.plugins["test-plugin"].sha256).toBe("a".repeat(64));
  });

  it("readLock throws on corrupt JSON", () => {
    writeFileSync(lockFile, "corrupt{{{");
    expect(() => readLock()).toThrow("invalid JSON");
  });

  it("readLock throws on unknown schema", () => {
    writeFileSync(lockFile, JSON.stringify({ schema: 999, plugins: {} }));
    expect(() => readLock()).toThrow("unknown schema");
  });

  it("file ends with newline", () => {
    writeLock({ schema: LOCK_SCHEMA, updated: "", plugins: {} });
    const raw = readFileSync(lockFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  // ─── recordInstall ──────────────────────────────────────────────

  it("recordInstall adds entry to lockfile", () => {
    const entry = recordInstall({
      name: "test-plugin",
      version: "1.0.0",
      sha256: "a".repeat(64),
      source: "http://example.com/test.tgz",
    });
    expect(entry.version).toBe("1.0.0");
    expect(entry.sha256).toBe("a".repeat(64));
    const lock = readLock();
    expect(lock.plugins["test-plugin"]).toBeDefined();
  });

  it("recordInstall preserves original added timestamp on update", () => {
    recordInstall({
      name: "test-plugin",
      version: "1.0.0",
      sha256: "a".repeat(64),
      source: "src1",
    });
    const first = readLock().plugins["test-plugin"].added;
    recordInstall({
      name: "test-plugin",
      version: "2.0.0",
      sha256: "b".repeat(64),
      source: "src2",
    });
    const second = readLock().plugins["test-plugin"];
    expect(second.version).toBe("2.0.0");
    expect(second.added).toBe(first); // preserved
  });

  it("recordInstall with linked flag", () => {
    const entry = recordInstall({
      name: "dev-plugin",
      version: "0.1.0",
      sha256: "c".repeat(64),
      source: "link:/tmp/dev",
      linked: true,
    });
    expect(entry.linked).toBe(true);
  });

  it("recordInstall with signers", () => {
    const entry = recordInstall({
      name: "signed-plugin",
      version: "1.0.0",
      sha256: "d".repeat(64),
      source: "registry",
      signers: ["alice", "bob"],
    });
    expect(entry.signers).toEqual(["alice", "bob"]);
  });

  it("recordInstall rejects invalid name", () => {
    expect(() => recordInstall({
      name: "",
      version: "1.0.0",
      sha256: "a".repeat(64),
      source: "x",
    })).toThrow("plugin name required");
  });

  it("recordInstall rejects invalid sha256", () => {
    expect(() => recordInstall({
      name: "test",
      version: "1.0.0",
      sha256: "invalid",
      source: "x",
    })).toThrow("invalid sha256");
  });

  it("recordInstall rejects missing version", () => {
    expect(() => recordInstall({
      name: "test",
      version: "",
      sha256: "a".repeat(64),
      source: "x",
    })).toThrow("version required");
  });

  it("recordInstall rejects missing source", () => {
    expect(() => recordInstall({
      name: "test",
      version: "1.0.0",
      sha256: "a".repeat(64),
      source: "",
    })).toThrow("source required");
  });

  // ─── unpinPlugin ────────────────────────────────────────────────

  it("unpinPlugin removes entry", () => {
    writeLock({
      schema: LOCK_SCHEMA,
      updated: "",
      plugins: {
        "to-remove": { version: "1.0.0", sha256: "a".repeat(64), source: "x", added: "2026-01-01" },
      },
    });
    const result = unpinPlugin("to-remove");
    expect(result.removed).not.toBeNull();
    expect(result.removed!.version).toBe("1.0.0");
    expect(readLock().plugins["to-remove"]).toBeUndefined();
  });

  it("unpinPlugin returns null removed for missing entry", () => {
    writeLock({ schema: LOCK_SCHEMA, updated: "", plugins: {} });
    const result = unpinPlugin("nonexistent");
    expect(result.removed).toBeNull();
  });

  it("unpinPlugin rejects invalid name", () => {
    expect(() => unpinPlugin("")).toThrow("plugin name required");
  });
});
