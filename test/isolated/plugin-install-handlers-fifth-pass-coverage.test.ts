/**
 * Fifth-pass focused executable coverage for install-handlers.ts.
 * Kept isolated because Bun module mocks are process-global.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sourceDetectPath = import.meta.resolve("../../src/commands/plugins/plugin/install-source-detect");
const extractionPath = import.meta.resolve("../../src/commands/plugins/plugin/install-extraction");
const manifestHelpersPath = import.meta.resolve("../../src/commands/plugins/plugin/install-manifest-helpers");
const lockPath = import.meta.resolve("../../src/commands/plugins/plugin/lock");
const registryPath = import.meta.resolve("../../src/plugin/registry");
const realChildProcess = await import("node:child_process");

type Manifest = {
  name: string;
  version: string;
  sdk: string;
  entry?: string;
  weight?: number;
  artifact?: { path: string; sha256: string | null };
};

type DownloadResult = { ok: true; path: string } | { ok: false; error: string };
type ExtractPlan = { manifest?: Manifest | null; subpaths?: Record<string, Manifest | null> };
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
let subpathThrows = new Map<string, unknown>();
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

function createPluginDir(parent: string, rel: string, manifest: Manifest | null): string {
  const dir = join(parent, rel);
  mkdirSync(dir, { recursive: true });
  if (manifest) {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    if (manifest.entry) writeFileSync(join(dir, manifest.entry), `export default ${JSON.stringify(manifest.name)};\n`);
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
  satisfies: () => true,
  hashFile: (path: string) => `sha256:${Buffer.from(path).toString("hex").slice(0, 64).padEnd(64, "0")}`,
}));

mock.module(extractionPath, () => ({
  extractTarball: (_tarballPath: string, staging: string) => {
    const plan = extractQueue.shift() ?? { manifest: defaultManifest() };
    if (Object.prototype.hasOwnProperty.call(plan, "manifest")) {
      const root = plan.manifest === null ? null : createPluginDir(staging, "plugin", plan.manifest ?? defaultManifest());
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
  verifyArtifactHash: () => ({ ok: true }),
  verifyArtifactHashAgainst: () => ({ ok: true }),
  isSourcePluginManifest: (manifest: Manifest) =>
    typeof manifest.entry === "string" && (!manifest.artifact || manifest.artifact.sha256 === null),
}));

mock.module(manifestHelpersPath, () => ({
  findPluginRoot: (staging: string) => pluginRootByStaging.get(staging) ?? null,
  findMonorepoPluginRoot: (staging: string, subpath: string) => {
    if (subpathThrows.has(subpath)) throw subpathThrows.get(subpath);
    return subpathRootByStaging.get(staging)?.get(subpath) ?? null;
  },
  readManifest: (dir: string) => manifestByDir.get(dir) ?? null,
  printInstallSuccess: (...args: unknown[]) => { printCalls.push(args); },
}));

mock.module(lockPath, () => ({
  readLock: () => ({ schema: 1, updated: "now", plugins: {} }),
  recordInstall: (input: RecordInstallCall) => { recordInstallCalls.push(input); return input; },
}));

mock.module("child_process", () => ({
  ...realChildProcess,
  spawnSync: () => ({ status: latestReleaseStatus, stdout: latestReleaseStdout, stderr: latestReleaseStatus === 0 ? "" : "no release" }),
}));

const handlers = await import("../../src/commands/plugins/plugin/install-handlers.ts?install-handlers-fifth-pass-coverage");
const { installFromDir, installFromGithub, installFromMonorepo, installFromUrl } = handlers;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-install-handlers-fifth-"));
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
  subpathThrows = new Map();
  latestReleaseStatus = 1;
  latestReleaseStdout = "";
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("install-handlers fifth-pass coverage", () => {
  test("link replacement drops stale weight overrides when incoming manifest has explicit weight", async () => {
    writeFileSync(join(installDir, ".overrides.json"), JSON.stringify({ weighted: 3 }, null, 2));
    createPluginDir(installDir, "weighted", { ...defaultManifest("weighted"), weight: 3 });
    const source = createPluginDir(tempRoot, "weighted-source", { ...defaultManifest("weighted"), weight: 41 });

    await installFromDir(source, { force: true });

    expect(JSON.parse(readFileSync(join(installDir, ".overrides.json"), "utf8"))).toEqual({});
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "weighted", source: `link:${source}`, linked: true });
  });

  test("download handlers surface download failures before tarball install", async () => {
    queueDownload({ ok: false, error: "url download failed" });
    await expect(installFromUrl("https://plugins.example/missing.tgz")).rejects.toThrow(/url download failed/);

    process.env.MAW_MONOREPO_BASE_URL = "https://mirror.example";
    process.env.MAW_MONOREPO_REGISTRY_REPO = "fork/registry";
    queueDownload({ ok: false, error: "monorepo download failed" });
    await expect(installFromMonorepo("plugins/tool", "v1.2.3")).rejects.toThrow(/monorepo download failed/);

    expect(downloadCalls).toEqual([
      "https://plugins.example/missing.tgz",
      "https://mirror.example/fork/registry/archive/refs/tags/v1.2.3.tar.gz",
    ]);
    expect(extractQueue).toEqual([]);
    expect(recordInstallCalls).toEqual([]);
  });

  test("github explicit tag succeeds without branch fallback or subpath probing", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const tarball = makeTarball("github-tag-success");
    queueDownload({ ok: true, path: tarball });
    queueExtract({ manifest: defaultManifest("github-tag-success") });

    await installFromGithub({ owner: "owner", repo: "repo", ref: "v1.0.0" }, { force: true, pin: true, weight: 5 });

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/refs/tags/v1.0.0.tar.gz"]);
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "github-tag-success", source: "github:owner/repo@v1.0.0" });
    expect(printCalls.at(-1)?.[3]).toBeUndefined();
    expect(existsSync(join(tarball, ".."))).toBe(false);
  });
  test("github single-segment fallback accepts non-Error sentinel throws", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const tarball = makeTarball("github-string-sentinel");
    queueDownload({ ok: true, path: tarball });
    subpathThrows.set("plugins/tool", "failed to read plugin manifest: no plugin.json at subpath 'plugins/tool'");
    queueExtract({ subpaths: { "plugins/tool": defaultManifest("unused-prefixed-root") } });
    queueExtract({ subpaths: { tool: defaultManifest("github-string-sentinel") } });

    await installFromGithub({ owner: "owner", repo: "repo", subpath: "tool", ref: "v2" }, { force: true });

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/refs/tags/v2.tar.gz"]);
    expect(recordInstallCalls.at(-1)).toMatchObject({
      name: "github-string-sentinel",
      source: "github:owner/repo/tool@v2",
    });
  });
});

