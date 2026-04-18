/**
 * plugins.lock — registry-pinned hash verification (#487 Option A).
 *
 * Covers the spec's §8 test matrix:
 *   • pin creates an entry; re-pin is idempotent when nothing changed.
 *   • pin of a missing / bad path rejects.
 *   • install <tarball> for an unpinned plugin fails with an actionable error.
 *   • install <tarball> for a pinned plugin with hash mismatch fails (the
 *     real adversarial check).
 *   • install --pin <new-tarball> adds entry and installs.
 *   • world-writable lockfile → CLI warns but proceeds.
 *   • schema version mismatch in lock → CLI refuses with migration hint.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { cmdPluginInstall } from "../../src/commands/plugins/plugin/install-impl";
import {
  readLock, writeLock, pinPlugin, unpinPlugin, validateSha256, validateName,
  LOCK_SCHEMA,
} from "../../src/commands/plugins/plugin/lock";
import {
  __resetDiscoverStateForTests, resetDiscoverCache,
} from "../../src/plugin/registry";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;

function tmpDir(prefix = "maw-lock-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }
function lockFile(): string { return process.env.MAW_PLUGINS_LOCK!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  const home = tmpDir("maw-home-");
  mkdirSync(home, { recursive: true });
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  __resetDiscoverStateForTests();
  resetDiscoverCache();
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  if (origPluginsLock !== undefined) process.env.MAW_PLUGINS_LOCK = origPluginsLock;
  else delete process.env.MAW_PLUGINS_LOCK;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/** Capture process.exit + console. Mirrors plugin-install.test.ts. */
async function capture(fn: () => Promise<unknown>): Promise<{
  exitCode: number | undefined; stdout: string; stderr: string;
}> {
  const o = { exit: process.exit, log: console.log, err: console.error, warn: console.warn };
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const outs: string[] = [], errs: string[] = [];
  let exitCode: number | undefined;
  console.log = (...a: any[]) => outs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => errs.push(a.map(String).join(" "));
  console.warn = (...a: any[]) => errs.push(a.map(String).join(" "));
  (process.stderr as any).write = (chunk: any) => {
    errs.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  (process as any).exit = (c?: number) => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e: any) {
    const msg = String(e?.message ?? "");
    if (!msg.startsWith("__exit__")) {
      if (e instanceof Error && exitCode === undefined) { exitCode = 1; errs.push(msg); }
      else throw e;
    }
  }
  finally {
    (process as any).exit = o.exit; console.log = o.log;
    console.error = o.err; console.warn = o.warn;
    (process.stderr as any).write = origStderrWrite;
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

/** Build a packed plugin fixture — reused from plugin-install.test.ts shape. */
function buildFixture(opts: {
  name?: string; version?: string; sdk?: string; bundleSrc?: string;
  overrideSha256?: string | null;
} = {}): { dir: string; bundle: string; sha256: string; tarball: string } {
  const name = opts.name ?? "hello";
  const version = opts.version ?? "0.1.0";
  const sdk = opts.sdk ?? "^1.0.0";
  const src = opts.bundleSrc ?? "export default () => ({ ok: true });\n";
  const dir = tmpDir("maw-fixture-");
  const bundle = join(dir, "index.js");
  writeFileSync(bundle, src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  const manifest: Record<string, unknown> = {
    name, version, sdk, target: "js", capabilities: [],
    artifact: {
      path: "./index.js",
      sha256: opts.overrideSha256 === undefined ? sha : opts.overrideSha256,
    },
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  const tarball = join(dir, `${name}-${version}.tgz`);
  const r = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json", "index.js"]);
  if (r.status !== 0) throw new Error("tar failed");
  return { dir, bundle, sha256: sha, tarball };
}

// ─── Validators ──────────────────────────────────────────────────────────────

describe("validators", () => {
  test("validateSha256 accepts bare and prefixed 64-hex", () => {
    const h = "a".repeat(64);
    expect(validateSha256(h).ok).toBe(true);
    expect(validateSha256("sha256:" + h).ok).toBe(true);
  });
  test("validateSha256 rejects wrong length / case / format", () => {
    expect(validateSha256("").ok).toBe(false);
    expect(validateSha256("a".repeat(63)).ok).toBe(false);
    expect(validateSha256("A".repeat(64)).ok).toBe(false);  // uppercase
    expect(validateSha256("g".repeat(64)).ok).toBe(false);  // non-hex
  });
  test("validateName rejects empty / weird", () => {
    expect(validateName("hello").ok).toBe(true);
    expect(validateName("hello-world").ok).toBe(true);
    expect(validateName("scope/name").ok).toBe(true);
    expect(validateName("").ok).toBe(false);
    expect(validateName("/leading").ok).toBe(false);
    expect(validateName("Upper").ok).toBe(false);
  });
});

// ─── read/write round-trip ───────────────────────────────────────────────────

describe("readLock / writeLock", () => {
  test("readLock returns empty default when file absent", () => {
    expect(existsSync(lockFile())).toBe(false);
    const lock = readLock();
    expect(lock.schema).toBe(LOCK_SCHEMA);
    expect(lock.plugins).toEqual({});
  });

  test("writeLock persists + readLock round-trips", () => {
    const now = new Date().toISOString();
    writeLock({
      schema: LOCK_SCHEMA,
      updated: now,
      plugins: {
        foo: { version: "1.0.0", sha256: "sha256:" + "a".repeat(64), source: "./foo.tgz", added: now },
      },
    });
    const lock = readLock();
    expect(lock.plugins.foo).toBeDefined();
    expect(lock.plugins.foo.version).toBe("1.0.0");
  });

  test("writeLock sets mode 0644", () => {
    writeLock({ schema: LOCK_SCHEMA, updated: new Date().toISOString(), plugins: {} });
    const { statSync } = require("fs");
    const mode = statSync(lockFile()).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("schema version mismatch → readLock throws with migration hint", () => {
    writeFileSync(lockFile(), JSON.stringify({ schema: 99, plugins: {} }));
    expect(() => readLock()).toThrow(/unknown schema 99/);
    expect(() => readLock()).toThrow(/migration/);
  });

  test("invalid JSON → readLock throws", () => {
    writeFileSync(lockFile(), "not json{");
    expect(() => readLock()).toThrow(/invalid JSON/);
  });

  test("world-writable lockfile → warns but proceeds", async () => {
    writeLock({ schema: LOCK_SCHEMA, updated: new Date().toISOString(), plugins: {} });
    chmodSync(lockFile(), 0o666);
    const { stderr } = await capture(async () => { readLock(); });
    expect(stderr).toMatch(/world-writable|group|chmod/i);
  });
});

// ─── pinPlugin / unpinPlugin ─────────────────────────────────────────────────

describe("pinPlugin / unpinPlugin", () => {
  test("pin creates entry + persists", () => {
    const fx = buildFixture();
    const r = pinPlugin("hello", fx.tarball);
    expect(r.entry.version).toBe("0.1.0");
    expect(r.entry.sha256).toBe(fx.sha256);
    expect(r.entry.source).toBe(fx.tarball);
    expect(r.previous).toBeUndefined();
    const lock = readLock();
    expect(lock.plugins.hello).toBeDefined();
    expect(lock.plugins.hello.sha256).toBe(fx.sha256);
  });

  test("re-pin with same content is idempotent (no change in version/sha)", () => {
    const fx = buildFixture();
    pinPlugin("hello", fx.tarball);
    const r = pinPlugin("hello", fx.tarball);
    expect(r.previous).toBeDefined();
    expect(r.entry.sha256).toBe(r.previous!.sha256);
    expect(r.entry.version).toBe(r.previous!.version);
    // `added` is preserved from the original entry.
    expect(r.entry.added).toBe(r.previous!.added);
  });

  test("pin of nonexistent tarball rejects", () => {
    expect(() => pinPlugin("ghost", "/nonexistent/path.tgz"))
      .toThrow(/source not found/);
  });

  test("pin of a non-tarball path rejects with a tar/parse error", () => {
    const junk = tmpDir();
    const notTar = join(junk, "nope.tgz");
    writeFileSync(notTar, "not a tarball");
    expect(() => pinPlugin("bad", notTar)).toThrow();
  });

  test("pin with --version mismatch rejects", () => {
    const fx = buildFixture({ version: "0.1.0" });
    expect(() => pinPlugin("hello", fx.tarball, { version: "9.9.9" }))
      .toThrow(/version mismatch/);
  });

  test("unpin removes entry; idempotent on missing name", () => {
    const fx = buildFixture();
    pinPlugin("hello", fx.tarball);
    expect(readLock().plugins.hello).toBeDefined();
    const r = unpinPlugin("hello");
    expect(r.removed?.version).toBe("0.1.0");
    expect(readLock().plugins.hello).toBeUndefined();
    const r2 = unpinPlugin("hello");
    expect(r2.removed).toBeNull();
  });
});

// ─── install integration — the real adversarial check ───────────────────────

describe("cmdPluginInstall + plugins.lock (#487)", () => {
  test("unpinned tarball install → refused with actionable error", async () => {
    const fx = buildFixture();
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([fx.tarball]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not in plugins.lock");
    expect(stderr).toContain("maw plugin pin");
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("pinned-then-installed happy path", async () => {
    const fx = buildFixture();
    pinPlugin("hello", fx.tarball);
    const { exitCode, stdout } = await capture(() => cmdPluginInstall([fx.tarball]));
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("installed");
    expect(existsSync(join(pluginsDir(), "hello", "index.js"))).toBe(true);
  });

  test("pinned with hash mismatch → refused (THE adversarial path)", async () => {
    // Pin the *legit* tarball. Then install a substituted tarball whose self-
    // manifest is internally consistent (passes the fencepost) but whose
    // artifact differs — so the lock-hash comparison is the one that catches it.
    const legit = buildFixture({ bundleSrc: "export default () => ({ real: true });\n" });
    pinPlugin("hello", legit.tarball);

    // Adversary's tarball: same name+version, different content, consistent self-hash.
    const evil = buildFixture({ bundleSrc: "export default () => ({ evil: true });\n" });
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([evil.tarball]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("hash mismatch");
    expect(stderr).toContain("lockfile");
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("pinned version skew → refused with clear error", async () => {
    const a = buildFixture({ version: "1.0.0" });
    pinPlugin("hello", a.tarball);
    const b = buildFixture({ version: "2.0.0" });
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([b.tarball]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("version mismatch");
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("--pin flag on first install adds entry AND installs", async () => {
    const fx = buildFixture();
    expect(readLock().plugins.hello).toBeUndefined();
    const { exitCode, stdout } = await capture(() => cmdPluginInstall([fx.tarball, "--pin"]));
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("installed");
    // Lockfile now has the entry.
    expect(readLock().plugins.hello?.version).toBe("0.1.0");
    expect(readLock().plugins.hello?.sha256).toBe(fx.sha256);
    // And the plugin actually landed on disk.
    expect(existsSync(join(pluginsDir(), "hello", "index.js"))).toBe(true);
  });

  test("schema-version-mismatched lock → install refuses with migration hint", async () => {
    const fx = buildFixture();
    writeFileSync(lockFile(), JSON.stringify({ schema: 99, plugins: {} }));
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([fx.tarball]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown schema 99");
    expect(stderr).toContain("migration");
  });
});
