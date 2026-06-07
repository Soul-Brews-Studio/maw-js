/**
 * Third-pass isolated branch coverage for install-handlers.ts.
 *
 * Mock dependencies before importing handlers so this file can exercise source
 * routing and lock branches without network, real extraction, or operator dirs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceDetectPath = import.meta.resolve("../../src/commands/plugins/plugin/install-source-detect");
const extractionPath = import.meta.resolve("../../src/commands/plugins/plugin/install-extraction");
const manifestHelpersPath = import.meta.resolve("../../src/commands/plugins/plugin/install-manifest-helpers");
const lockPath = import.meta.resolve("../../src/commands/plugins/plugin/lock");
const registryPath = import.meta.resolve("../../src/plugin/registry");

type Manifest = {
  name: string;
  version: string;
  sdk: string;
  entry?: string;
  weight?: number;
  artifact?: { path: string; sha256: string | null };
};

type DownloadResult = { ok: true; path: string } | { ok: false; error: string };
type ExtractPlan = { ok?: boolean; error?: string; manifest?: Manifest | null; readManifestNull?: boolean; subpaths?: Record<string, Manifest | null> };
type RecordInstallCall = { name: string; version: string; sha256: string; source: string; linked?: boolean };

let tempRoot = "";
let installDir = "";
let manifestByDir = new Map<string, Manifest | null>();
let pluginRootByStaging = new Map<string, string | null>();
let subpathRootByStaging = new Map<string, Map<string, string | null>>();
let extractQueue: ExtractPlan[] = [];
let downloadQueue: DownloadResult[] = [];
let downloadCalls: string[] = [];
let recordInstallCalls: RecordInstallCall[] = [];
let printCalls: unknown[][] = [];
let lockPlugins: Record<string, { version: string; sha256: string; source: string; added: string }> = {};
let pinnedHashOk = true;
let sdkOk = true;
let selfHashOk = true;
let readLockError: Error | null = null;
let readManifestThrows = new Set<string>();
let latestReleaseStatus = 1;
let latestReleaseStdout = "";

const originalEnv = {
  pluginsDir: process.env.MAW_PLUGINS_DIR,
  pluginsLock: process.env.MAW_PLUGINS_LOCK,
  mawJsPath: process.env.MAW_JS_PATH,
  githubBase: process.env.MAW_GITHUB_BASE_URL,
  monorepoBase: process.env.MAW_MONOREPO_BASE_URL,
  monorepoRepo: process.env.MAW_MONOREPO_REGISTRY_REPO,
};

function restoreEnv() {
  for (const [key, value] of Object.entries({
    MAW_PLUGINS_DIR: originalEnv.pluginsDir,
    MAW_PLUGINS_LOCK: originalEnv.pluginsLock,
    MAW_JS_PATH: originalEnv.mawJsPath,
    MAW_GITHUB_BASE_URL: originalEnv.githubBase,
    MAW_MONOREPO_BASE_URL: originalEnv.monorepoBase,
    MAW_MONOREPO_REGISTRY_REPO: originalEnv.monorepoRepo,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function defaultManifest(name = "demo"): Manifest {
  return {
    name,
    version: "1.0.0",
    sdk: "*",
    entry: "index.ts",
    artifact: { path: "index.ts", sha256: "sha256:" + "a".repeat(64) },
  };
}

function sourceManifest(name = "source-demo"): Manifest {
  return { name, version: "1.0.0", sdk: "*", entry: "src/index.ts", artifact: undefined };
}

function createPluginDir(parent: string, rel: string, manifest: Manifest | null): string {
  const dir = join(parent, rel);
  mkdirSync(dir, { recursive: true });
  if (manifest) {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    if (manifest.entry) {
      const entryPath = join(dir, manifest.entry);
      mkdirSync(join(entryPath, ".."), { recursive: true });
      writeFileSync(entryPath, `export default ${JSON.stringify(manifest.name)};\n`);
    }
    if (manifest.artifact?.path && manifest.artifact.sha256 !== null) {
      const artifactPath = join(dir, manifest.artifact.path);
      mkdirSync(join(artifactPath, ".."), { recursive: true });
      if (!existsSync(artifactPath)) writeFileSync(artifactPath, `artifact:${manifest.name}\n`);
    }
  }
  manifestByDir.set(dir, manifest);
  return dir;
}

function makeTarball(label: string): string {
  const dir = mkdtempSync(join(tempRoot, `${label}-`));
  const path = join(dir, `${label}.tgz`);
  writeFileSync(path, `tarball:${label}`);
  return path;
}

function queueExtract(plan: ExtractPlan = {}): void { extractQueue.push(plan); }
function queueDownload(result: DownloadResult): void { downloadQueue.push(result); }

mock.module(sourceDetectPath, () => ({
  installRoot: () => installDir,
  removeExisting: (dest: string) => rmSync(dest, { recursive: true, force: true }),
}));

mock.module(registryPath, () => ({
  formatSdkMismatchError: (name: string, wanted: string, runtime: string) =>
    `sdk mismatch for ${name}: wanted ${wanted}, runtime ${runtime}`,
  runtimeSdkVersion: () => "1.0.0",
  satisfies: () => sdkOk,
  hashFile: (path: string) => `sha256:${Buffer.from(path).toString("hex").slice(0, 64).padEnd(64, "0")}`,
}));

mock.module(extractionPath, () => ({
  extractTarball: (_tarballPath: string, staging: string) => {
    const plan = extractQueue.shift() ?? { manifest: defaultManifest() };
    if (plan.ok === false) return { ok: false, error: plan.error ?? "extract failed" };
    if (Object.prototype.hasOwnProperty.call(plan, "manifest")) {
      const root = plan.manifest === null ? null : createPluginDir(staging, "plugin", plan.manifest ?? defaultManifest());
      if (root && plan.readManifestNull) manifestByDir.set(root, null);
      pluginRootByStaging.set(staging, root);
    } else {
      pluginRootByStaging.set(staging, createPluginDir(staging, "plugin", defaultManifest()));
    }
    const subpaths = new Map<string, string | null>();
    for (const [subpath, manifest] of Object.entries(plan.subpaths ?? {})) {
      subpaths.set(subpath, manifest === null ? null : createPluginDir(staging, subpath, manifest));
    }
    subpathRootByStaging.set(staging, subpaths);
    return { ok: true };
  },
  downloadTarball: async (url: string) => {
    downloadCalls.push(url);
    return downloadQueue.shift() ?? { ok: false, error: `unexpected download: ${url}` };
  },
  verifyArtifactHash: () => selfHashOk ? { ok: true } : { ok: false, error: "self hash failed" },
  verifyArtifactHashAgainst: () => pinnedHashOk ? { ok: true } : { ok: false, error: "pinned hash failed" },
  isSourcePluginManifest: (manifest: Manifest) =>
    typeof manifest.entry === "string" && (!manifest.artifact || manifest.artifact.sha256 === null),
}));

mock.module(manifestHelpersPath, () => ({
  findPluginRoot: (staging: string) => pluginRootByStaging.get(staging) ?? null,
  findMonorepoPluginRoot: (staging: string, subpath: string) => subpathRootByStaging.get(staging)?.get(subpath) ?? null,
  readManifest: (dir: string) => {
    if (readManifestThrows.has(dir)) throw new Error("manifest read exploded");
    return manifestByDir.get(dir) ?? null;
  },
  printInstallSuccess: (...args: unknown[]) => { printCalls.push(args); },
}));

mock.module(lockPath, () => ({
  readLock: () => {
    if (readLockError) throw readLockError;
    return { schema: 1, updated: "now", plugins: lockPlugins };
  },
  recordInstall: (input: RecordInstallCall) => {
    recordInstallCalls.push(input);
    lockPlugins[input.name] = { ...input, added: "now" };
    return lockPlugins[input.name];
  },
}));

mock.module("child_process", () => ({
  spawnSync: () => ({ status: latestReleaseStatus, stdout: latestReleaseStdout, stderr: latestReleaseStatus === 0 ? "" : "no release" }),
}));

const handlers = await import("../../src/commands/plugins/plugin/install-handlers.ts?install-handlers-third-pass-coverage");
const {
  ensurePluginMawJsLink,
  githubBaseUrl,
  installFromDir,
  installFromGithub,
  installFromMonorepo,
  installFromTarball,
  installFromUrl,
  monorepoRepoSlug,
  monorepoTarballUrl,
} = handlers;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-install-handlers-third-"));
  installDir = join(tempRoot, "plugins");
  mkdirSync(installDir, { recursive: true });
  process.env.MAW_PLUGINS_DIR = installDir;
  process.env.MAW_PLUGINS_LOCK = join(tempRoot, "plugins.lock");
  process.env.MAW_JS_PATH = join(tempRoot, "maw-js-root");
  mkdirSync(process.env.MAW_JS_PATH, { recursive: true });
  delete process.env.MAW_GITHUB_BASE_URL;
  delete process.env.MAW_MONOREPO_BASE_URL;
  delete process.env.MAW_MONOREPO_REGISTRY_REPO;

  manifestByDir = new Map();
  pluginRootByStaging = new Map();
  subpathRootByStaging = new Map();
  extractQueue = [];
  downloadQueue = [];
  downloadCalls = [];
  recordInstallCalls = [];
  printCalls = [];
  lockPlugins = {};
  pinnedHashOk = true;
  sdkOk = true;
  selfHashOk = true;
  readLockError = null;
  readManifestThrows = new Set();
  latestReleaseStatus = 1;
  latestReleaseStdout = "";
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("install-handlers third-pass coverage", () => {
  test("replace installs tolerate unreadable prior weight and tarball extraction failures clean staging", async () => {
    const replaceSource = createPluginDir(tempRoot, "replace-source", { ...defaultManifest("replace-me"), weight: undefined });
    const priorDest = createPluginDir(installDir, "replace-me", { ...defaultManifest("replace-me"), weight: 4 });
    readManifestThrows.add(priorDest);

    await installFromDir(replaceSource, { force: true });

    expect(readManifestThrows.has(priorDest)).toBe(true);
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "replace-me", linked: true });
    const overridesPath = join(installDir, ".overrides.json");
    expect(JSON.parse(readFileSync(overridesPath, "utf8"))).toEqual({});

    queueExtract({ ok: false, error: "extract boom" });
    await expect(installFromTarball(makeTarball("extract-boom"), { source: "extract-boom" }))
      .rejects.toThrow(/extract boom/);
  });

  test("maw-js link helper replaces stale symlinks and preserves real targets", () => {
    const linkedSource = createPluginDir(tempRoot, "linked-source", defaultManifest("linked-source"));
    const nodeModules = join(linkedSource, "node_modules");
    const target = join(nodeModules, "maw-js");
    const wrongRoot = join(tempRoot, "wrong-maw-js");
    mkdirSync(wrongRoot, { recursive: true });
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(wrongRoot, target, "dir");

    ensurePluginMawJsLink(linkedSource);

    expect(readlinkSync(target)).toBe(process.env.MAW_JS_PATH);
    ensurePluginMawJsLink(linkedSource);
    expect(readlinkSync(target)).toBe(process.env.MAW_JS_PATH);

    const realTargetSource = createPluginDir(tempRoot, "real-target-source", defaultManifest("real-target"));
    const realTarget = join(realTargetSource, "node_modules", "maw-js");
    mkdirSync(realTarget, { recursive: true });
    ensurePluginMawJsLink(realTargetSource);
    expect(lstatSync(realTarget).isDirectory()).toBe(true);
    expect(lstatSync(realTarget).isSymbolicLink()).toBe(false);
  });

  test("dir installs report missing, non-directory, sdk mismatch, and existing real-directory conflicts", async () => {
    await expect(installFromDir(join(tempRoot, "missing"))).rejects.toThrow(/source not found/);
    const notDir = join(tempRoot, "not-dir");
    writeFileSync(notDir, "plugin");
    await expect(installFromDir(notDir)).rejects.toThrow(/not a directory/);

    const sdkSource = createPluginDir(tempRoot, "sdk-source", { ...defaultManifest("sdk-dir"), sdk: ">=99" });
    sdkOk = false;
    await expect(installFromDir(sdkSource)).rejects.toThrow(/sdk mismatch for sdk-dir/);
    sdkOk = true;

    const conflictSource = createPluginDir(tempRoot, "conflict-source", defaultManifest("conflict-dir"));
    mkdirSync(join(installDir, "conflict-dir"), { recursive: true });
    await expect(installFromDir(conflictSource)).rejects.toThrow(/existing: .*conflict-dir .*real directory/);
  });

  test("tarball install reports guard failures before mutating installs", async () => {
    await expect(installFromTarball(join(tempRoot, "missing.tgz"), { source: "missing" }))
      .rejects.toThrow(/tarball not found/);

    queueExtract({});
    await expect(installFromTarball(makeTarball("missing-root"), { source: "missing-root", subpath: "plugins/none" }))
      .rejects.toThrow(/no plugin\.json at subpath 'plugins\/none'/);

    queueExtract({ manifest: null });
    await expect(installFromTarball(makeTarball("missing-manifest"), { source: "missing-manifest" }))
      .rejects.toThrow(/no plugin\.json at/);

    queueExtract({ manifest: defaultManifest("unreadable"), readManifestNull: true });
    await expect(installFromTarball(makeTarball("unreadable"), { source: "unreadable" }))
      .rejects.toThrow(/failed to read plugin manifest/);

    sdkOk = false;
    queueExtract({ manifest: { ...defaultManifest("sdk-tarball"), sdk: ">=99" } });
    await expect(installFromTarball(makeTarball("sdk-tarball"), { source: "sdk-tarball" }))
      .rejects.toThrow(/sdk mismatch for sdk-tarball/);
    sdkOk = true;

    selfHashOk = false;
    queueExtract({ manifest: defaultManifest("self-hash") });
    await expect(installFromTarball(makeTarball("self-hash"), { source: "self-hash" }))
      .rejects.toThrow(/self hash failed/);
    selfHashOk = true;

    readLockError = new Error("lock unreadable");
    queueExtract({ manifest: defaultManifest("lock-fail") });
    await expect(installFromTarball(makeTarball("lock-fail"), { source: "lock-fail" }))
      .rejects.toThrow(/lock unreadable/);
    readLockError = null;

    lockPlugins["versioned"] = { version: "0.9.0", sha256: "sha256:" + "c".repeat(64), source: "old", added: "old" };
    queueExtract({ manifest: defaultManifest("versioned") });
    await expect(installFromTarball(makeTarball("versioned"), { source: "versioned" }))
      .rejects.toThrow(/version mismatch/);

    queueExtract({ manifest: defaultManifest("tar-conflict") });
    mkdirSync(join(installDir, "tar-conflict"), { recursive: true });
    await expect(installFromTarball(makeTarball("tar-conflict"), { source: "tar-conflict" }))
      .rejects.toThrow(/existing: .*tar-conflict .*real directory/);

    expect(recordInstallCalls).toEqual([]);
  });

  test("tarball install falls back when rename fails", async () => {
    const fsModule = require("fs") as typeof import("node:fs");
    const originalRename = fsModule.renameSync;
    fsModule.renameSync = (() => { throw new Error("cross-device"); }) as typeof fsModule.renameSync;
    try {
      queueExtract({ manifest: defaultManifest("rename-fallback") });
      await installFromTarball(makeTarball("rename-fallback"), { source: "rename-fallback", force: true });
    } finally {
      fsModule.renameSync = originalRename;
    }

    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "rename-fallback", source: "rename-fallback" });
  });

  test("url and monorepo installers route downloads and cleanup through tarball install", async () => {
    await expect(installFromUrl("https://plugins.example/missing.tgz"))
      .rejects.toThrow(/unexpected download/);

    const urlTarball = makeTarball("url-success");
    queueDownload({ ok: true, path: urlTarball });
    queueExtract({ manifest: defaultManifest("url-success") });
    await installFromUrl("https://plugins.example/url-success.tgz", { force: true, pin: true, weight: 5 });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "url-success", source: "https://plugins.example/url-success.tgz" });
    expect(printCalls.at(-1)?.[3]).toBe("from https://plugins.example/url-success.tgz");
    expect(existsSync(join(urlTarball, ".."))).toBe(false);

    process.env.MAW_MONOREPO_BASE_URL = "https://mono.example";
    process.env.MAW_MONOREPO_REGISTRY_REPO = "fork/registry";
    expect(monorepoRepoSlug()).toBe("fork/registry");
    expect(monorepoTarballUrl("v7")).toBe("https://mono.example/fork/registry/archive/refs/tags/v7.tar.gz");

    await expect(installFromMonorepo("plugins/missing", "v7"))
      .rejects.toThrow(/unexpected download/);

    const monorepoTarball = makeTarball("monorepo-success");
    queueDownload({ ok: true, path: monorepoTarball });
    queueExtract({ subpaths: { "plugins/tool": defaultManifest("monorepo-tool") } });
    await installFromMonorepo("plugins/tool", "v7", { force: true });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "monorepo-tool", source: "monorepo:plugins/tool@v7" });
    expect(existsSync(join(monorepoTarball, ".."))).toBe(false);
  });

  test("github handler covers latest-release, default-branch fallback, and fetch failure paths", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    expect(githubBaseUrl()).toBe("https://gh.example");

    latestReleaseStatus = 0;
    latestReleaseStdout = "v9.0.0\n";
    const latestTarball = makeTarball("github-latest");
    queueDownload({ ok: true, path: latestTarball });
    queueExtract({ manifest: defaultManifest("github-latest") });
    await installFromGithub({ owner: "owner", repo: "repo" }, { force: true });
    expect(downloadCalls.at(-1)).toBe("https://gh.example/owner/repo/archive/refs/tags/v9.0.0.tar.gz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "github-latest", source: "github:owner/repo" });

    latestReleaseStatus = 1;
    latestReleaseStdout = "";
    const headTarball = makeTarball("github-head");
    queueDownload({ ok: true, path: headTarball });
    queueExtract({ manifest: defaultManifest("github-head") });
    await installFromGithub({ owner: "owner", repo: "repo" }, { force: true });
    expect(downloadCalls.at(-1)).toBe("https://gh.example/owner/repo/archive/HEAD.tar.gz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "github-head", source: "github:owner/repo" });

    queueDownload({ ok: false, error: "tag gone" });
    queueDownload({ ok: false, error: "branch gone" });
    await expect(installFromGithub({ owner: "owner", repo: "repo", ref: "dead" }))
      .rejects.toThrow(/failed to fetch github archive.*branch gone.*refs\/tags\/dead.*refs\/heads\/dead/s);
  });

  test("installFromDir stores explicit weight for a fresh link install with corrupt prior overrides", async () => {
    writeFileSync(join(installDir, ".overrides.json"), "{not json");
    const source = createPluginDir(tempRoot, "weighted-link", { ...defaultManifest("weighted-link"), weight: undefined });

    await installFromDir(source, { weight: 17 });

    expect(JSON.parse(readFileSync(join(installDir, ".overrides.json"), "utf8"))).toEqual({ "weighted-link": 17 });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "weighted-link", linked: true, source: `link:${source}` });
  });

  test("installFromTarball reports unknown observed hash for source-shaped pinned mismatch", async () => {
    lockPlugins["unknown-observed"] = { version: "1.0.0", sha256: "sha256:" + "b".repeat(64), source: "old", added: "old" };
    pinnedHashOk = false;
    queueExtract({ manifest: sourceManifest("unknown-observed") });

    await expect(installFromTarball(makeTarball("unknown-observed"), { source: "unknown-observed" }))
      .rejects.toThrow(/tarball:\s+\(unknown\)/);

    expect(recordInstallCalls).toEqual([]);
  });

  test("github handler returns after successful single-segment plugins subpath probe", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const ghTarball = makeTarball("github-prefixed-success");
    queueDownload({ ok: false, error: "tag missing" });
    queueDownload({ ok: true, path: ghTarball });
    queueExtract({ subpaths: { "plugins/tool": defaultManifest("prefixed-tool") } });

    await installFromGithub({ owner: "owner", repo: "repo", subpath: "tool", ref: "feature" }, { force: true, pin: true, weight: 13 });

    expect(downloadCalls).toEqual([
      "https://gh.example/owner/repo/archive/refs/tags/feature.tar.gz",
      "https://gh.example/owner/repo/archive/refs/heads/feature.tar.gz",
    ]);
    expect(recordInstallCalls).toHaveLength(1);
    expect(recordInstallCalls[0]).toMatchObject({ name: "prefixed-tool", source: "github:owner/repo/tool@feature" });
    expect(printCalls.at(-1)?.[1]).toBe(join(installDir, "prefixed-tool"));
    expect(existsSync(join(ghTarball, ".."))).toBe(false);
  });

  test("github handler passes slash subpaths directly to tarball install", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const ghTarball = makeTarball("github-direct-subpath");
    queueDownload({ ok: true, path: ghTarball });
    queueExtract({ subpaths: { "nested/tool": defaultManifest("nested-tool") } });

    await installFromGithub({ owner: "owner", repo: "repo", subpath: "nested/tool", ref: "v1" }, { force: true });

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/refs/tags/v1.tar.gz"]);
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "nested-tool", source: "github:owner/repo/nested/tool@v1" });
  });

  test("github handler falls back from plugins-prefixed probe to literal single-segment subpath", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const ghTarball = makeTarball("github-literal-subpath");
    queueDownload({ ok: true, path: ghTarball });
    queueExtract({ subpaths: { "plugins/tool": null } });
    queueExtract({ subpaths: { tool: defaultManifest("literal-tool") } });

    await installFromGithub({ owner: "owner", repo: "repo", subpath: "tool", ref: "v2" }, { force: true });

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/refs/tags/v2.tar.gz"]);
    expect(recordInstallCalls).toHaveLength(1);
    expect(recordInstallCalls[0]).toMatchObject({ name: "literal-tool", source: "github:owner/repo/tool@v2" });
    expect(printCalls.at(-1)?.[1]).toBe(join(installDir, "literal-tool"));
    expect(existsSync(join(ghTarball, ".."))).toBe(false);
  });
});
