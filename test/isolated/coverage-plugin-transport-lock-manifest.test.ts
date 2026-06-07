import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { OracleEntry } from "../../src/core/fleet/oracle-registry";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";

const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalCacheDir = process.env.MAW_CACHE_DIR;
const originalStateDir = process.env.MAW_STATE_DIR;
const originalHome = process.env.MAW_HOME;
const originalTestMode = process.env.MAW_TEST_MODE;
const originalLock = process.env.MAW_PLUGINS_LOCK;

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-plugin-transport-manifest-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_CACHE_DIR = TEST_CONFIG_DIR;
process.env.MAW_STATE_DIR = TEST_CONFIG_DIR;
process.env.MAW_TEST_MODE = "1";
delete process.env.MAW_HOME;

const config = await import("../../src/config");
const manifest = await import("../../src/lib/oracle-manifest");
const helpers = await import("../../src/commands/plugins/plugin/install-manifest-helpers");
const lock = await import("../../src/commands/plugins/plugin/lock");

const HASH_A = "a".repeat(64);
let tmp = "";

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalCacheDir === undefined) delete process.env.MAW_CACHE_DIR;
  else process.env.MAW_CACHE_DIR = originalCacheDir;
  if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalStateDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalTestMode;
  if (originalLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalLock;
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-plugin-transport-lock-"));
  process.env.MAW_PLUGINS_LOCK = join(tmp, "nested", "plugins.lock");
  rmSync(CONFIG_FILE, { force: true });
  rmSync(ORACLES_JSON, { force: true });
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
  mkdirSync(TEST_FLEET_DIR, { recursive: true });
  config.resetConfig();
  manifest.invalidateManifest();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(body: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(body), "utf8");
  config.resetConfig();
}

function writeFleet(file: string, body: unknown) {
  writeFileSync(join(TEST_FLEET_DIR, file), JSON.stringify(body), "utf8");
}

function writeOraclesJson(oracles: OracleEntry[]) {
  writeFileSync(ORACLES_JSON, JSON.stringify({ schema: 1, oracles }), "utf8");
}

function oracleEntry(name: string, patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    name,
    local_path: `/tmp/${name}-oracle`,
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: "white",
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

function withMutedConsole<T>(fn: () => T): T {
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

function buildTarball(opts: {
  name: string;
  version?: string;
  manifestPatch?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmp, "fixture-"));
  mkdirSync(dir, { recursive: true });
  const manifestBody = {
    name: opts.name,
    version: opts.version ?? "1.0.0",
    sdk: "^1.0.0",
    target: "js",
    capabilities: [],
    artifact: { path: "dist/index.js", sha256: `sha256:${HASH_A}` },
    ...opts.manifestPatch,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifestBody, null, 2) + "\n", "utf8");

  const hashes: Record<string, string> = {};
  const files = opts.files ?? { "dist/index.js": "export default 'artifact';\n" };
  for (const [relativePath, body] of Object.entries(files)) {
    const path = join(dir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
    hashes[relativePath] = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  const tarball = join(dir, `${opts.name}.tgz`);
  const tarArgs = ["-czf", tarball, "-C", dir, "plugin.json", ...Object.keys(files)];
  const result = spawnSync("tar", tarArgs);
  if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr)}`);
  return { tarball, hashes };
}

describe("install manifest helper coverage", () => {
  test("findPluginRoot handles flat, wrapped, and missing manifests", () => {
    const flat = join(tmp, "flat");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "plugin.json"), "{}", "utf8");
    expect(helpers.findPluginRoot(flat)).toBe(flat);

    const wrapped = join(tmp, "root-wrapped");
    mkdirSync(join(wrapped, "package"), { recursive: true });
    writeFileSync(join(wrapped, "package", "plugin.json"), "{}", "utf8");
    expect(helpers.findPluginRoot(wrapped)).toBe(join(wrapped, "package"));

    const crowded = join(tmp, "root-crowded");
    mkdirSync(join(crowded, "one"), { recursive: true });
    mkdirSync(join(crowded, "two"), { recursive: true });
    expect(helpers.findPluginRoot(crowded)).toBeNull();
  });

  test("finds direct and wrapped monorepo plugin roots and rejects unsafe shapes", () => {
    const direct = join(tmp, "direct");
    mkdirSync(join(direct, "plugins", "shape"), { recursive: true });
    writeFileSync(join(direct, "plugins", "shape", "plugin.json"), "{}", "utf8");
    expect(helpers.findMonorepoPluginRoot(direct, "plugins/shape")).toBe(join(direct, "plugins", "shape"));

    const wrapped = join(tmp, "wrapped");
    mkdirSync(join(wrapped, "repo-wrap", "plugins", "shape"), { recursive: true });
    writeFileSync(join(wrapped, "repo-wrap", "plugins", "shape", "plugin.json"), "{}", "utf8");
    expect(helpers.findMonorepoPluginRoot(wrapped, "plugins/shape")).toBe(join(wrapped, "repo-wrap", "plugins", "shape"));

    const notReadable = join(tmp, "not-readable");
    writeFileSync(notReadable, "not a dir", "utf8");
    expect(helpers.findMonorepoPluginRoot(notReadable, "plugins/shape")).toBeNull();

    const crowded = join(tmp, "crowded");
    mkdirSync(join(crowded, "one"), { recursive: true });
    mkdirSync(join(crowded, "two"), { recursive: true });
    expect(helpers.findMonorepoPluginRoot(crowded, "plugins/shape")).toBeNull();

    const oneFile = join(tmp, "one-file");
    mkdirSync(oneFile, { recursive: true });
    writeFileSync(join(oneFile, "file"), "x", "utf8");
    expect(helpers.findMonorepoPluginRoot(oneFile, "plugins/shape")).toBeNull();
  });

  test("readManifest, shortHash, and success printing cover failure and label branches", () => {
    expect(withMutedConsole(() => helpers.readManifest(join(tmp, "missing")))).toBeNull();

    const invalid = join(tmp, "invalid");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, "plugin.json"), "{not json", "utf8");
    expect(withMutedConsole(() => helpers.readManifest(invalid))).toBeNull();

    expect(helpers.shortHash("sha256:abcdef123456")).toBe("abcdef1");
    expect(helpers.shortHash("123456789")).toBe("1234567");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      helpers.printInstallSuccess(
        {
          name: "tool",
          version: "1.0.0",
          sdk: "^1.0.0",
          target: "js",
          capabilities: [],
        },
        "/tmp/tool",
        { sha256: "sha256:abcdef123456" },
        "from registry",
      );
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("tool@1.0.0 installed from registry");
    expect(logs.join("\n")).toContain("capabilities: (none)");
    expect(logs.join("\n")).toContain("mode: installed (sha256:abcdef1…)");
    expect(logs.join("\n")).toContain("try: maw tool");
  });
});

describe("plugin lock coverage", () => {
  test("validators and recordInstall cover invalid inputs and normalized writes", () => {
    expect(lock.validateName("scope/plugin_1").ok).toBe(true);
    expect(lock.validateName("").ok).toBe(false);
    expect(lock.validateSha256(`sha256:${HASH_A}`).ok).toBe(true);
    expect(lock.validateSha256(HASH_A.toUpperCase()).ok).toBe(false);

    expect(() =>
      lock.recordInstall({ name: "tool", version: "", sha256: HASH_A, source: "./tool.tgz" }),
    ).toThrow(/version required/);
    expect(() =>
      lock.recordInstall({ name: "tool", version: "1.0.0", sha256: HASH_A, source: "" }),
    ).toThrow(/source required/);

    const first = lock.recordInstall({
      name: "tool",
      version: "1.0.0",
      sha256: HASH_A,
      source: "link:/tmp/tool",
      linked: true,
      signers: ["alice"],
    });
    const second = lock.recordInstall({
      name: "tool",
      version: "1.0.1",
      sha256: HASH_A,
      source: "./tool.tgz",
    });

    expect(second.added).toBe(first.added);
    expect(second.linked).toBeUndefined();
    expect(second.signers).toBeUndefined();
    expect(lock.readLock().plugins.tool.version).toBe("1.0.1");
  });

  test("readLock warns but proceeds for loose lockfile permissions", () => {
    lock.writeLock({
      schema: lock.LOCK_SCHEMA,
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        tool: { version: "1.0.0", sha256: HASH_A, source: "./tool.tgz", added: "2026-05-18T00:00:00.000Z" },
      },
    });
    chmodSync(process.env.MAW_PLUGINS_LOCK!, 0o666);

    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      expect(lock.readLock().plugins.tool.version).toBe("1.0.0");
    } finally {
      (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    }
    expect(writes.join("")).toContain("group/world-writable");
  });

  test("unpinPlugin validates names and removes existing entries", () => {
    expect(() => lock.unpinPlugin("BadName")).toThrow(/invalid plugin name/);
    expect(lock.unpinPlugin("ghost")).toEqual({ name: "ghost", removed: null });

    lock.recordInstall({
      name: "tool",
      version: "1.0.0",
      sha256: HASH_A,
      source: "./tool.tgz",
    });
    expect(lock.unpinPlugin("tool").removed?.version).toBe("1.0.0");
    expect(lock.readLock().plugins.tool).toBeUndefined();
  });

  test("pinPlugin hashes artifact bytes, preserves previous metadata, and rejects skew", () => {
    const fixture = buildTarball({
      name: "artifact-tool",
      version: "2.0.0",
      files: { "dist/index.js": "export default 'artifact bytes';\n" },
    });

    const first = lock.pinPlugin("artifact-tool", fixture.tarball, {
      version: "2.0.0",
      signers: ["alice"],
    });
    const second = lock.pinPlugin("artifact-tool", fixture.tarball);

    expect(first.entry).toMatchObject({
      version: "2.0.0",
      sha256: fixture.hashes["dist/index.js"],
      signers: ["alice"],
    });
    expect(second.previous?.sha256).toBe(fixture.hashes["dist/index.js"]);
    expect(second.entry.added).toBe(first.entry.added);
    expect(() => lock.pinPlugin("artifact-tool", fixture.tarball, { version: "9.9.9" })).toThrow(/version mismatch/);
    expect(() => lock.pinPlugin("artifact-tool", join(tmp, "absent.tgz"))).toThrow(/source not found/);
  });
});

describe("oracle manifest coverage", () => {
  test("loadManifest merges fleet, sessions, suffix agents, and registry cache precedence", () => {
    writeFleet("010-local.json", {
      name: "fleet-session",
      windows: [
        { name: "fleeted-oracle", repo: "fleet/repo" },
        { name: "not-an-oracle", repo: "ignored/repo" },
        {},
      ],
    });
    writeConfig({
      sessions: { "": "skip", solo: "session-id" },
      agents: {
        solo: "",
        "solo-oracle": "mba",
        "fleeted-oracle": "remote-node",
        "suffixonly-oracle": "white",
      },
    });
    writeOraclesJson([
      oracleEntry("solo"),
      oracleEntry("fleeted", { federation_node: "ignored", local_path: "/tmp/fleeted-cache" }),
      oracleEntry("cacheonly"),
    ]);

    const entries = manifest.loadManifest();
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect(byName.get("fleeted")).toMatchObject({
      node: "local",
      repo: "fleet/repo",
      session: "fleet-session",
      window: "fleeted-oracle",
      localPath: "/tmp/fleeted-cache",
    });
    expect(byName.get("solo")).toMatchObject({
      sessionId: "session-id",
      localPath: "/tmp/solo-oracle",
      node: "mba",
    });
    expect(byName.get("suffixonly")).toMatchObject({ node: "white", sources: ["agent"] });
    expect(byName.get("cacheonly")).toMatchObject({ repo: "Soul-Brews-Studio/cacheonly-oracle" });
    expect(manifest.findOracle("cacheonly")?.localPath).toBe("/tmp/cacheonly-oracle");

    const cached = manifest.loadManifestCached(30_000);
    expect(manifest.loadManifestCached(30_000)).toBe(cached);
    expect(manifest.readFleetWindows(join(TEST_CONFIG_DIR, "absent-fleet"))).toEqual([]);
  });

  test("direct registry merges preserve existing fields and async scan updates existing entries", async () => {
    const entry = {
      name: "direct",
      sources: ["fleet"],
      isLive: false,
      repo: "fleet/repo",
      localPath: "/tmp/original",
      node: "local",
      hasFleetConfig: true,
    } as OracleManifestEntry;

    manifest.mergeOraclesJsonEntry(entry, oracleEntry("direct", {
      org: "CacheOrg",
      repo: "cache-repo",
      local_path: "/tmp/cache",
      federation_node: "cache-node",
      has_fleet_config: false,
    }));
    expect(entry).toMatchObject({
      repo: "fleet/repo",
      localPath: "/tmp/original",
      node: "local",
      hasFleetConfig: true,
    });
    expect(entry.sources).toEqual(["fleet", "oracles-json"]);

    writeConfig({ sessions: { direct: "session-id" } });
    const asyncEntries = await manifest.loadManifestAsync(async () => [
      { path: "/tmp/worktree-direct", tmuxWindow: "direct-oracle" },
      { path: "/tmp/nope", tmuxWindow: "plain" },
    ]);
    expect(asyncEntries.find((e) => e.name === "direct")).toMatchObject({
      localPath: "/tmp/worktree-direct",
      sources: ["session", "worktree"],
    });

    const first = await manifest.loadManifestCachedAsync(30_000, async () => [
      { path: "/tmp/cached", tmuxWindow: "cached-oracle" },
    ]);
    const second = await manifest.loadManifestCachedAsync(30_000, async () => []);
    expect(second).toBe(first);
    manifest.invalidateManifest();
    const refreshed = await manifest.loadManifestCachedAsync(0, async () => [
      { path: "/tmp/refreshed", mainRepo: "org/refreshed-oracle" },
    ]);
    expect(refreshed.find((e) => e.name === "refreshed")?.localPath).toBe("/tmp/refreshed");
  });
});
