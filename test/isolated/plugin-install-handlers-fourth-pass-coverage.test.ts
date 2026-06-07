/**
 * Fourth-pass focused executable coverage for install-handlers.ts.
 *
 * Keep this file isolated: Bun module mocks are process-global, and isolated
 * tests run each file in its own process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

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
type ExtractPlan = {
  manifest?: Manifest | null;
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
let latestReleaseStatus = 1;
let latestReleaseStdout = "";

const originalEnv = {
  pluginsDir: process.env.MAW_PLUGINS_DIR,
  pluginsLock: process.env.MAW_PLUGINS_LOCK,
  mawJsPath: process.env.MAW_JS_PATH,
  githubBase: process.env.MAW_GITHUB_BASE_URL,
};

function restoreEnv() {
  for (const [key, value] of Object.entries({
    MAW_PLUGINS_DIR: originalEnv.pluginsDir,
    MAW_PLUGINS_LOCK: originalEnv.pluginsLock,
    MAW_JS_PATH: originalEnv.mawJsPath,
    MAW_GITHUB_BASE_URL: originalEnv.githubBase,
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
    if (manifest.entry) {
      const entryPath = join(dir, manifest.entry);
      mkdirSync(join(entryPath, ".."), { recursive: true });
      writeFileSync(entryPath, `export default ${JSON.stringify(manifest.name)};\n`);
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
  verifyArtifactHashAgainst: () => pinnedHashOk ? { ok: true } : { ok: false, error: "pinned hash failed" },
  isSourcePluginManifest: (manifest: Manifest) =>
    typeof manifest.entry === "string" && (!manifest.artifact || manifest.artifact.sha256 === null),
}));

mock.module(manifestHelpersPath, () => ({
  findPluginRoot: (staging: string) => pluginRootByStaging.get(staging) ?? null,
  findMonorepoPluginRoot: (staging: string, subpath: string) => subpathRootByStaging.get(staging)?.get(subpath) ?? null,
  readManifest: (dir: string) => manifestByDir.get(dir) ?? null,
  printInstallSuccess: (...args: unknown[]) => { printCalls.push(args); },
}));

mock.module(lockPath, () => ({
  readLock: () => ({ schema: 1, updated: "now", plugins: lockPlugins }),
  recordInstall: (input: RecordInstallCall) => {
    recordInstallCalls.push(input);
    lockPlugins[input.name] = { ...input, added: "now" };
    return lockPlugins[input.name];
  },
}));

mock.module("child_process", () => ({
  ...realChildProcess,
  spawnSync: () => ({
    status: latestReleaseStatus,
    stdout: latestReleaseStdout,
    stderr: latestReleaseStatus === 0 ? "" : "no release",
  }),
}));

const handlers = await import("../../src/commands/plugins/plugin/install-handlers.ts?install-handlers-fourth-pass-coverage");
const { ensurePluginMawJsLink, installFromDir, installFromGithub, installFromTarball } = handlers;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-install-handlers-fourth-"));
  installDir = join(tempRoot, "plugins");
  mkdirSync(installDir, { recursive: true });
  process.env.MAW_PLUGINS_DIR = installDir;
  process.env.MAW_PLUGINS_LOCK = join(tempRoot, "plugins.lock");
  process.env.MAW_JS_PATH = join(tempRoot, "maw-js-root");
  mkdirSync(process.env.MAW_JS_PATH, { recursive: true });
  delete process.env.MAW_GITHUB_BASE_URL;

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
  latestReleaseStatus = 1;
  latestReleaseStdout = "";
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("install-handlers fourth-pass coverage", () => {
  test("dir install rejects missing manifests and reports existing symlink targets", async () => {
    const manifestless = createPluginDir(tempRoot, "manifestless", null);
    await expect(installFromDir(manifestless)).rejects.toThrow(/failed to read plugin manifest/);

    const source = createPluginDir(tempRoot, "symlink-conflict-source", defaultManifest("symlink-conflict"));
    const existingTarget = join(tempRoot, "already-linked-target");
    mkdirSync(existingTarget, { recursive: true });
    symlinkSync(existingTarget, join(installDir, "symlink-conflict"), "dir");

    await expect(installFromDir(source)).rejects.toThrow(new RegExp(`existing: .*symlink-conflict.*${existingTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(recordInstallCalls).toEqual([]);
  });

  test("maw-js link helper falls back to repo root when MAW_JS_PATH is absent", () => {
    const previous = process.env.MAW_JS_PATH;
    delete process.env.MAW_JS_PATH;
    const source = createPluginDir(tempRoot, "default-root-source", defaultManifest("default-root"));

    try {
      ensurePluginMawJsLink(source);
    } finally {
      if (previous === undefined) delete process.env.MAW_JS_PATH;
      else process.env.MAW_JS_PATH = previous;
    }

    const target = join(source, "node_modules", "maw-js");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(resolve(join(source, "node_modules"), readlinkSync(target))).toBe(process.cwd());
  });

  test("tarball install allows explicit pin re-trust and omits source note for non-http sources", async () => {
    lockPlugins["repinned"] = {
      version: "1.0.0",
      sha256: "sha256:" + "b".repeat(64),
      source: "old",
      added: "old",
    };
    pinnedHashOk = false;
    queueExtract({ manifest: defaultManifest("repinned") });

    await installFromTarball(makeTarball("repinned"), { source: "local-repin", pin: true });

    expect(recordInstallCalls.at(-1)).toMatchObject({
      name: "repinned",
      source: "local-repin",
      sha256: "sha256:" + "a".repeat(64),
    });
    expect(printCalls.at(-1)?.[3]).toBeUndefined();
  });

  test("tarball install records entry hash when artifact sha is missing on an artifact-shaped manifest", async () => {
    const manifest = {
      ...defaultManifest("entry-fallback"),
      artifact: { path: "dist/index.js" } as Manifest["artifact"],
    };
    queueExtract({ manifest });

    await installFromTarball(makeTarball("entry-fallback"), { source: "entry-fallback" });

    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "entry-fallback", source: "entry-fallback" });
    expect(recordInstallCalls.at(-1)?.sha256).toMatch(/^sha256:/);
  });

  test("github install treats empty latest-release stdout as no release and uses HEAD", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    latestReleaseStatus = 0;
    latestReleaseStdout = "\n";
    const tarball = makeTarball("github-empty-latest");
    queueDownload({ ok: true, path: tarball });
    queueExtract({ manifest: defaultManifest("github-empty-latest") });

    await installFromGithub({ owner: "owner", repo: "repo" }, { force: true });

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/HEAD.tar.gz"]);
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "github-empty-latest", source: "github:owner/repo" });
    expect(existsSync(join(tarball, ".."))).toBe(false);
  });

  test("github install rethrows real prefixed-subpath errors without trying literal fallback", async () => {
    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    const tarball = makeTarball("github-prefixed-sdk-error");
    queueDownload({ ok: true, path: tarball });
    queueExtract({ subpaths: { "plugins/tool": { ...defaultManifest("prefixed-sdk-error"), sdk: ">=99" } } });
    sdkOk = false;

    await expect(installFromGithub({ owner: "owner", repo: "repo", subpath: "tool", ref: "v1" }))
      .rejects.toThrow(/sdk mismatch for prefixed-sdk-error/);

    expect(downloadCalls).toEqual(["https://gh.example/owner/repo/archive/refs/tags/v1.tar.gz"]);
    expect(extractQueue).toHaveLength(0);
    expect(recordInstallCalls).toEqual([]);
  });
});
