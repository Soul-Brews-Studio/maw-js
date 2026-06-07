/**
 * Runtime coverage for install-handlers.ts source routing and guard rails.
 *
 * Dependency modules are mocked before import so this file exercises the handler
 * control flow without network, real tar extraction, or the operator's plugin
 * directories. Keep this isolated: mock.module is process-global in Bun.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
type ExtractPlan = {
  ok?: boolean;
  error?: string;
  manifest?: Manifest | null;
  readManifestNull?: boolean;
  subpaths?: Record<string, Manifest | null>;
};

type RecordInstallCall = {
  name: string;
  version: string;
  sha256: string;
  source: string;
  linked?: boolean;
};

let tempRoot = "";
let installDir = "";
let mawRoot = "";
let manifestByDir = new Map<string, Manifest | null>();
let pluginRootByStaging = new Map<string, string | null>();
let subpathRootByStaging = new Map<string, Map<string, string | null>>();
let extractQueue: ExtractPlan[] = [];
let downloadQueue: DownloadResult[] = [];
let downloadCalls: string[] = [];
let recordInstallCalls: RecordInstallCall[] = [];
let printCalls: unknown[][] = [];
let lockPlugins: Record<string, { version: string; sha256: string; source: string; added: string }> = {};
let readLockError: Error | null = null;
let sdkOk = true;
let selfHashOk = true;
let pinnedHashOk = true;
let latestReleaseTag: string | null = null;

const originalEnv = {
  pluginsDir: process.env.MAW_PLUGINS_DIR,
  pluginsLock: process.env.MAW_PLUGINS_LOCK,
  mawJsPath: process.env.MAW_JS_PATH,
  githubBase: process.env.MAW_GITHUB_BASE_URL,
  monorepoBase: process.env.MAW_MONOREPO_BASE_URL,
  monorepoRepo: process.env.MAW_MONOREPO_REGISTRY_REPO,
};

function restoreEnv() {
  const pairs: Array<[keyof NodeJS.ProcessEnv, string | undefined]> = [
    ["MAW_PLUGINS_DIR", originalEnv.pluginsDir],
    ["MAW_PLUGINS_LOCK", originalEnv.pluginsLock],
    ["MAW_JS_PATH", originalEnv.mawJsPath],
    ["MAW_GITHUB_BASE_URL", originalEnv.githubBase],
    ["MAW_MONOREPO_BASE_URL", originalEnv.monorepoBase],
    ["MAW_MONOREPO_REGISTRY_REPO", originalEnv.monorepoRepo],
  ];
  for (const [key, value] of pairs) {
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
  return {
    name,
    version: "1.0.0",
    sdk: "*",
    entry: "src/index.ts",
    artifact: { path: "dist/missing.js", sha256: null },
  };
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

function queueExtract(plan: ExtractPlan = {}): void {
  extractQueue.push(plan);
}

function queueDownload(result: DownloadResult): void {
  downloadQueue.push(result);
}

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
    const result = downloadQueue.shift() ?? { ok: false, error: `unexpected download: ${url}` };
    return result;
  },
  verifyArtifactHash: () => selfHashOk ? { ok: true } : { ok: false, error: "self hash failed" },
  verifyArtifactHashAgainst: () => pinnedHashOk ? { ok: true } : { ok: false, error: "pinned hash failed" },
  isSourcePluginManifest: (manifest: Manifest) =>
    typeof manifest.entry === "string" && (!manifest.artifact || manifest.artifact.sha256 === null),
}));

mock.module(manifestHelpersPath, () => ({
  findPluginRoot: (staging: string) => pluginRootByStaging.get(staging) ?? null,
  findMonorepoPluginRoot: (staging: string, subpath: string) =>
    subpathRootByStaging.get(staging)?.get(subpath) ?? null,
  readManifest: (dir: string) => manifestByDir.get(dir) ?? null,
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
  spawnSync: () => latestReleaseTag
    ? { status: 0, stdout: `${latestReleaseTag}\n`, stderr: "" }
    : { status: 1, stdout: "", stderr: "no release" },
}));

const handlers = await import("../../src/commands/plugins/plugin/install-handlers.ts?install-handlers-coverage");
const {
  ensurePluginMawJsLink,
  githubBaseUrl,
  installFromDir,
  installFromGithub,
  installFromMonorepo,
  installFromTarball,
  installFromUrl,
} = handlers;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-install-handlers-"));
  installDir = join(tempRoot, "plugins");
  mawRoot = join(tempRoot, "maw-js-root");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(mawRoot, { recursive: true });
  process.env.MAW_PLUGINS_DIR = installDir;
  process.env.MAW_PLUGINS_LOCK = join(tempRoot, "plugins.lock");
  process.env.MAW_JS_PATH = mawRoot;
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
  readLockError = null;
  sdkOk = true;
  selfHashOk = true;
  pinnedHashOk = true;
  latestReleaseTag = null;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("install-handlers coverage", () => {
  test("installFromTarball rejects guard failures before mutating install root", async () => {
    await expect(installFromTarball(join(tempRoot, "missing.tgz"), { source: "missing" }))
      .rejects.toThrow(/tarball not found/);

    const extractFail = makeTarball("extract-fail");
    queueExtract({ ok: false, error: "fixture extract failed" });
    await expect(installFromTarball(extractFail, { source: "extract-fail" }))
      .rejects.toThrow(/fixture extract failed/);

    const noRoot = makeTarball("no-root");
    queueExtract({ manifest: null });
    await expect(installFromTarball(noRoot, { source: "no-root" }))
      .rejects.toThrow(/no plugin.json at/);

    const noSubpath = makeTarball("no-subpath");
    queueExtract({ subpaths: { "plugins/missing": null } });
    await expect(installFromTarball(noSubpath, { source: "no-subpath", subpath: "plugins/missing" }))
      .rejects.toThrow(/no plugin.json at subpath 'plugins\/missing'/);

    const manifestMissing = makeTarball("manifest-missing");
    queueExtract({ manifest: defaultManifest("manifest-missing"), readManifestNull: true });
    await expect(installFromTarball(manifestMissing, { source: "manifest-missing" }))
      .rejects.toThrow(/failed to read plugin manifest/);

    sdkOk = false;
    queueExtract({ manifest: defaultManifest("sdk-bad") });
    await expect(installFromTarball(makeTarball("sdk-bad"), { source: "sdk-bad" }))
      .rejects.toThrow(/sdk mismatch for sdk-bad/);
    sdkOk = true;

    selfHashOk = false;
    queueExtract({ manifest: defaultManifest("self-hash-bad") });
    await expect(installFromTarball(makeTarball("self-hash-bad"), { source: "self-hash-bad" }))
      .rejects.toThrow(/self hash failed/);
    selfHashOk = true;

    readLockError = new Error("lock unreadable");
    queueExtract({ manifest: defaultManifest("lock-bad") });
    await expect(installFromTarball(makeTarball("lock-bad"), { source: "lock-bad" }))
      .rejects.toThrow(/lock unreadable/);
    readLockError = null;

    lockPlugins["version-bad"] = { version: "0.9.0", sha256: "sha256:" + "b".repeat(64), source: "old", added: "old" };
    queueExtract({ manifest: defaultManifest("version-bad") });
    await expect(installFromTarball(makeTarball("version-bad"), { source: "version-bad" }))
      .rejects.toThrow(/version mismatch/);

    lockPlugins["sha-bad"] = { version: "1.0.0", sha256: "sha256:" + "c".repeat(64), source: "old", added: "old" };
    pinnedHashOk = false;
    queueExtract({ manifest: defaultManifest("sha-bad") });
    await expect(installFromTarball(makeTarball("sha-bad"), { source: "sha-bad" }))
      .rejects.toThrow(/sha256 mismatch/);

    const refuseExisting = makeTarball("tarball-refuse");
    mkdirSync(join(installDir, "tarball-refuse"), { recursive: true });
    queueExtract({ manifest: defaultManifest("tarball-refuse") });
    await expect(installFromTarball(refuseExisting, { source: "tarball-refuse" }))
      .rejects.toThrow(/refusing to overwrite plugin 'tarball-refuse'/);

    expect(recordInstallCalls).toEqual([]);
  });

  test("installFromTarball force-installs source-shaped plugin, preserves explicit weight, and records entry hash", async () => {
    const manifest = sourceManifest("source-demo");
    const dest = join(installDir, manifest.name);
    mkdirSync(dest, { recursive: true });
    manifestByDir.set(dest, { ...manifest, weight: 7 });
    lockPlugins[manifest.name] = { version: "1.0.0", sha256: "sha256:" + "d".repeat(64), source: "old", added: "old" };
    pinnedHashOk = false;
    queueExtract({ manifest });

    await installFromTarball(makeTarball("source-demo"), {
      source: "fixture-source",
      force: true,
      weight: 22,
      pin: true,
    });

    expect(existsSync(join(dest, "plugin.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(installDir, ".overrides.json"), "utf-8"))).toEqual({ "source-demo": 22 });
    expect(recordInstallCalls.at(-1)).toMatchObject({
      name: "source-demo",
      version: "1.0.0",
      source: "fixture-source",
    });
    expect(recordInstallCalls.at(-1)?.sha256).toMatch(/^sha256:/);
    expect(printCalls.at(-1)?.[1]).toBe(dest);
  });

  test("installFromDir validates source, links plugins, preserves replacement weight, and records link installs", async () => {
    await expect(installFromDir(join(tempRoot, "missing-dir"))).rejects.toThrow(/source not found/);

    const fileSource = join(tempRoot, "not-dir");
    writeFileSync(fileSource, "not a directory");
    await expect(installFromDir(fileSource)).rejects.toThrow(/not a directory/);

    const sdkSource = createPluginDir(tempRoot, "sdk-source", defaultManifest("sdk-source"));
    sdkOk = false;
    await expect(installFromDir(sdkSource)).rejects.toThrow(/sdk mismatch for sdk-source/);
    sdkOk = true;

    const refusedSource = createPluginDir(tempRoot, "refused-source", defaultManifest("refused"));
    mkdirSync(join(installDir, "refused"), { recursive: true });
    await expect(installFromDir(refusedSource)).rejects.toThrow(/refusing to overwrite plugin 'refused'/);

    const src = createPluginDir(tempRoot, "linked-source", { ...defaultManifest("linked"), weight: undefined });
    const dest = join(installDir, "linked");
    mkdirSync(dest, { recursive: true });
    manifestByDir.set(dest, { ...defaultManifest("linked"), weight: 3 });

    await installFromDir(src, { force: true });

    expect(existsSync(dest)).toBe(true);
    expect(JSON.parse(readFileSync(join(installDir, ".overrides.json"), "utf-8"))).toEqual({ linked: 3 });
    expect(existsSync(join(src, "node_modules", "maw-js"))).toBe(true);
    expect(recordInstallCalls.at(-1)).toMatchObject({
      name: "linked",
      version: "1.0.0",
      source: `link:${src}`,
      linked: true,
    });
  });

  test("ensurePluginMawJsLink replaces stale symlinks, no-ops correct links, and preserves real dirs", () => {
    const symlinkSource = createPluginDir(tempRoot, "symlink-source", defaultManifest("symlink-source"));
    const nodeModules = join(symlinkSource, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    const wrongTarget = join(tempRoot, "wrong-maw-js");
    mkdirSync(wrongTarget, { recursive: true });
    symlinkSync(wrongTarget, join(nodeModules, "maw-js"), "dir");

    ensurePluginMawJsLink(symlinkSource);
    expect(readlinkSync(join(nodeModules, "maw-js"))).toBe(mawRoot);

    ensurePluginMawJsLink(symlinkSource);
    expect(readlinkSync(join(nodeModules, "maw-js"))).toBe(mawRoot);

    const realDirSource = createPluginDir(tempRoot, "real-dir-source", defaultManifest("real-dir-source"));
    const realDirLinkPath = join(realDirSource, "node_modules", "maw-js");
    mkdirSync(realDirLinkPath, { recursive: true });

    ensurePluginMawJsLink(realDirSource);
    expect(readlinkSync(join(nodeModules, "maw-js"))).toBe(mawRoot);
    expect(existsSync(realDirLinkPath)).toBe(true);
  });

  test("installFromUrl and installFromMonorepo delegate through tarball install and clean download tempdirs", async () => {
    queueDownload({ ok: false, error: "download failed" });
    await expect(installFromUrl("https://registry.example/missing.tgz"))
      .rejects.toThrow(/download failed/);
    downloadCalls = [];

    const urlTarball = makeTarball("url");
    const urlTemp = join(urlTarball, "..");
    queueDownload({ ok: true, path: urlTarball });
    queueExtract({ manifest: defaultManifest("url-demo") });

    await installFromUrl("https://registry.example/plugin.tgz", { force: true });

    expect(downloadCalls).toEqual(["https://registry.example/plugin.tgz"]);
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "url-demo", source: "https://registry.example/plugin.tgz" });
    expect(existsSync(urlTemp)).toBe(false);

    process.env.MAW_MONOREPO_BASE_URL = "https://mirror.example";
    process.env.MAW_MONOREPO_REGISTRY_REPO = "fork/registry";
    const monoTarball = makeTarball("mono");
    const monoTemp = join(monoTarball, "..");
    queueDownload({ ok: true, path: monoTarball });
    queueExtract({ subpaths: { "plugins/mono": defaultManifest("mono-demo") } });

    await installFromMonorepo("plugins/mono", "v1.2.3", { force: true });

    expect(downloadCalls.at(-1)).toBe("https://mirror.example/fork/registry/archive/refs/tags/v1.2.3.tar.gz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "mono-demo", source: "monorepo:plugins/mono@v1.2.3" });
    expect(existsSync(monoTemp)).toBe(false);
  });

  test("installFromGithub falls back tag-to-branch and plugins/subpath-to-literal", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    expect(githubBaseUrl()).toBe("https://gh.example");

    queueDownload({ ok: false, error: "tag 404" });
    const ghTarball = makeTarball("github-branch");
    queueDownload({ ok: true, path: ghTarball });
    queueExtract({ subpaths: { "plugins/tool": null } });
    queueExtract({ subpaths: { tool: defaultManifest("literal-tool") } });

    await installFromGithub(
      { owner: "owner", repo: "repo", subpath: "tool", ref: "dev" },
      { force: true },
    );

    expect(downloadCalls).toEqual([
      "https://gh.example/owner/repo/archive/refs/tags/dev.tar.gz",
      "https://gh.example/owner/repo/archive/refs/heads/dev.tar.gz",
    ]);
    expect(recordInstallCalls.at(-1)).toMatchObject({
      name: "literal-tool",
      source: "github:owner/repo/tool@dev",
    });
    expect(existsSync(join(ghTarball, ".."))).toBe(false);
  });

  test("installFromGithub uses latest release when available and reports attempted URLs when all downloads fail", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    latestReleaseTag = "v9.9.9";
    const latestTarball = makeTarball("github-latest");
    queueDownload({ ok: true, path: latestTarball });
    queueExtract({ manifest: defaultManifest("latest-tool") });

    await installFromGithub({ owner: "owner", repo: "repo" }, { force: true });

    expect(downloadCalls.at(-1)).toBe("https://gh.example/owner/repo/archive/refs/tags/v9.9.9.tar.gz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "latest-tool", source: "github:owner/repo" });

    downloadCalls = [];
    latestReleaseTag = null;
    queueDownload({ ok: false, error: "HEAD 404" });
    await expect(installFromGithub({ owner: "owner", repo: "repo" }))
      .rejects.toThrow(/failed to fetch github archive/);
    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/HEAD.tar.gz"]);
  });
});
