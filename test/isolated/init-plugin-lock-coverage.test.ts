import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  LOCK_SCHEMA,
  lockPath,
  pinPlugin,
  readLock,
  recordInstall,
  unpinPlugin,
  validateName,
  validateSchema,
  validateSha256,
  writeLock,
} from "../../src/vendor/mpr-plugins/init/internal/plugin-lock";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let tmp: string;
let originalLock: string | undefined;
let originalHome: string | undefined;
let originalData: string | undefined;

beforeEach(() => {
  originalLock = process.env.MAW_PLUGINS_LOCK;
  originalHome = process.env.MAW_HOME;
  originalData = process.env.MAW_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "maw-init-plugin-lock-"));
  process.env.MAW_PLUGINS_LOCK = join(tmp, "nested", "plugins.lock");
});

afterEach(() => {
  if (originalLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalLock;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalData === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = originalData;
  rmSync(tmp, { recursive: true, force: true });
});

describe("vendor init plugin-lock validators and schema", () => {
  test("accepts canonical names and hashes while rejecting malformed input", () => {
    expect(validateName("scope/plugin.name-1").ok).toBe(true);
    expect(validateName("Upper").ok).toBe(false);
    expect(validateName("/leading").ok).toBe(false);

    expect(validateSha256(HASH_A).ok).toBe(true);
    expect(validateSha256(`sha256:${HASH_A}`).ok).toBe(true);
    expect(validateSha256(HASH_A.toUpperCase()).ok).toBe(false);
  });

  test("validateSchema normalizes optional fields and rejects unsafe shapes", () => {
    const parsed = validateSchema({
      schema: LOCK_SCHEMA,
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        health: {
          version: "1.0.0",
          sha256: `sha256:${HASH_A}`,
          source: "./health.tgz",
          linked: true,
          signers: ["alice", 42, "bob"],
        },
      },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.lock.plugins.health.added).toBe("2026-05-18T00:00:00.000Z");
      expect(parsed.lock.plugins.health.linked).toBe(true);
      expect(parsed.lock.plugins.health.signers).toEqual(["alice", "bob"]);
    }

    expect(validateSchema({ schema: 999, plugins: {} }).ok).toBe(false);
    expect(validateSchema({ schema: LOCK_SCHEMA, plugins: [] }).ok).toBe(false);
  });
});

describe("vendor init plugin-lock read/write operations", () => {
  test("lockPath honors MAW_PLUGINS_LOCK and readLock returns an empty first-use lock", () => {
    expect(lockPath()).toBe(process.env.MAW_PLUGINS_LOCK!);
    expect(readLock()).toMatchObject({ schema: LOCK_SCHEMA, plugins: {} });
  });

  test("lockPath follows MAW_DATA_DIR when the explicit lock override is absent", () => {
    const dataDir = join(tmp, "data");
    delete process.env.MAW_PLUGINS_LOCK;
    delete process.env.MAW_HOME;
    process.env.MAW_DATA_DIR = dataDir;

    expect(lockPath()).toBe(join(dataDir, "plugins.lock"));
    writeLock({
      schema: LOCK_SCHEMA,
      updated: "old timestamp is replaced on write",
      plugins: {
        health: { version: "1.0.0", sha256: HASH_A, source: "./health.tgz", added: "2026-04-01T00:00:00.000Z" },
      },
    });
    expect(existsSync(join(dataDir, "plugins.lock"))).toBe(true);
  });

  test("writeLock creates parent directories, writes mode 0644, and readLock warns but proceeds on loose mode", () => {
    writeLock({
      schema: LOCK_SCHEMA,
      updated: "old timestamp is replaced on write",
      plugins: {
        health: { version: "1.0.0", sha256: HASH_A, source: "./health.tgz", added: "2026-04-01T00:00:00.000Z" },
      },
    });

    expect(existsSync(process.env.MAW_PLUGINS_LOCK!)).toBe(true);
    expect(statSync(process.env.MAW_PLUGINS_LOCK!).mode & 0o777).toBe(0o644);
    expect(readLock().plugins.health.sha256).toBe(HASH_A);

    chmodSync(process.env.MAW_PLUGINS_LOCK!, 0o666);
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      expect(readLock().plugins.health.version).toBe("1.0.0");
    } finally {
      (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    }
    expect(writes.join("")).toContain("group/world-writable");
  });
});

describe("vendor init plugin-lock mutations", () => {
  test("recordInstall preserves first-added timestamp, updates fields, and toggles linked/signers", async () => {
    const first = recordInstall({
      name: "health",
      version: "1.0.0",
      sha256: HASH_A,
      source: "link:/dev/health",
      linked: true,
      signers: ["alice"],
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = recordInstall({ name: "health", version: "1.0.1", sha256: HASH_B, source: "./health.tgz" });

    expect(second.added).toBe(first.added);
    expect(second).toMatchObject({ version: "1.0.1", sha256: HASH_B, source: "./health.tgz" });
    expect(second.linked).toBeUndefined();
    expect(second.signers).toBeUndefined();
    expect(Object.keys(readLock().plugins)).toEqual(["health"]);
  });

  test("recordInstall and unpinPlugin validate inputs and no-op cleanly for missing entries", () => {
    expect(() => recordInstall({ name: "Bad", version: "1.0.0", sha256: HASH_A, source: "./bad.tgz" })).toThrow(
      /invalid plugin name/,
    );
    expect(() => recordInstall({ name: "health", version: "", sha256: HASH_A, source: "./bad.tgz" })).toThrow(
      /version required/,
    );
    expect(() => recordInstall({ name: "health", version: "1.0.0", sha256: "abc", source: "./bad.tgz" })).toThrow(
      /invalid sha256/,
    );
    expect(unpinPlugin("ghost")).toEqual({ name: "ghost", removed: null });

    recordInstall({ name: "health", version: "1.0.0", sha256: HASH_A, source: "./health.tgz" });
    expect(unpinPlugin("health").removed?.sha256).toBe(HASH_A);
    expect(readLock().plugins.health).toBeUndefined();
  });
});

describe("vendor init plugin-lock pinPlugin tarball hashing", () => {
  test("pins source-shaped tarballs by hashing entry bytes and preserving previous added on re-pin", async () => {
    const fixture = buildTarball({
      name: "dream-init",
      version: "0.2.0",
      entry: "index.js",
      body: "export default function plugin() { return 'dream'; }\n",
    });

    const first = pinPlugin("dream-init", fixture.tarball, { signers: ["alice"] });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = pinPlugin("dream-init", fixture.tarball);

    expect(first.entry).toMatchObject({ version: "0.2.0", sha256: fixture.sha256, source: fixture.tarball, signers: ["alice"] });
    expect(second.previous?.sha256).toBe(fixture.sha256);
    expect(second.entry.added).toBe(first.entry.added);
    expect(readLock().plugins["dream-init"].sha256).toBe(fixture.sha256);
  });

  test("pinPlugin rejects version skew and tarballs whose manifest cannot resolve an entry", () => {
    const valid = buildTarball({ name: "dream-init", version: "0.2.0", entry: "index.js", body: "export default {};\n" });
    const missingEntry = buildTarball({ name: "dream-init", version: "0.2.0", entry: "missing.js", body: null });

    expect(() => pinPlugin("dream-init", valid.tarball, { version: "9.9.9" })).toThrow(/version mismatch/);
    withMutedConsoleError(() => {
      expect(() => pinPlugin("dream-init", missingEntry.tarball)).toThrow(/failed to read plugin\.json from tarball/);
    });
  });
});

function buildTarball(opts: { name: string; version: string; entry: string; body: string | null }): { tarball: string; sha256: string } {
  const dir = mkdtempSync(join(tmp, "fixture-"));
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: opts.name,
    version: opts.version,
    sdk: "^1.0.0",
    target: "js",
    capabilities: [],
    entry: opts.entry,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (opts.body !== null) writeFileSync(join(dir, opts.entry), opts.body);
  const tarball = join(dir, `${opts.name}-${opts.version}.tgz`);
  const args = opts.body === null
    ? ["-czf", tarball, "-C", dir, "plugin.json"]
    : ["-czf", tarball, "-C", dir, "plugin.json", opts.entry];
  const result = spawnSync("tar", args);
  if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr)}`);
  const sha256 = opts.body === null ? "" : `sha256:${createHash("sha256").update(opts.body).digest("hex")}`;
  return { tarball, sha256 };
}

function withMutedConsoleError(fn: () => void): void {
  const original = console.error;
  console.error = () => undefined;
  try {
    fn();
  } finally {
    console.error = original;
  }
}
