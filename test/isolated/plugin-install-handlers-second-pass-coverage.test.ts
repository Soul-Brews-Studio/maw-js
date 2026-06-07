/**
 * Second-pass isolated edge coverage for install-handlers.ts.
 *
 * Keep this file self-contained: Bun module mocks are process-global, and
 * scripts/test-isolated.sh runs each isolated file in its own process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

type ExtractPlan = {
  manifest?: Manifest | null;
  subpaths?: Record<string, Manifest | null>;
};

type DownloadResult = { ok: true; path: string } | { ok: false; error: string };

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
  readLock: () => ({ schema: 1, updated: "now", plugins: lockPlugins }),
  recordInstall: (input: RecordInstallCall) => {
    recordInstallCalls.push(input);
    lockPlugins[input.name] = { ...input, added: "now" };
    return lockPlugins[input.name];
  },
}));

mock.module("child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => {
    return { status: latestReleaseStatus, stdout: latestReleaseStdout, stderr: latestReleaseStatus === 0 ? "" : "no release" };
  },
}));

const handlers = await import("../../src/commands/plugins/plugin/install-handlers.ts?install-handlers-second-pass-coverage");
const {
  installFromDir,
  installFromGithub,
  installFromMonorepo,
  installFromTarball,
  installFromUrl,
  monorepoRepoSlug,
  monorepoTarballUrl,
} = handlers;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-install-handlers-second-"));
  installDir = join(tempRoot, "plugins");
  mkdirSync(installDir, { recursive: true });
  process.env.MAW_PLUGINS_DIR = installDir;
  process.env.MAW_PLUGINS_LOCK = join(tempRoot, "plugins.lock");
  delete process.env.MAW_JS_PATH;
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
  latestReleaseStatus = 1;
  latestReleaseStdout = "";
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("install-handlers second-pass coverage", () => {
  test("link installs cover default maw-js root, manifest-missing, symlink refusal, and incoming-weight override cleanup", async () => {
    const noManifest = createPluginDir(tempRoot, "no-manifest", null);
    await expect(installFromDir(noManifest)).rejects.toThrow(/failed to read plugin manifest/);

    const defaultRootSource = createPluginDir(tempRoot, "default-root-source", defaultManifest("default-root"));
    await installFromDir(defaultRootSource);
    expect(resolve(join(defaultRootSource, "node_modules"), readlinkSync(join(defaultRootSource, "node_modules", "maw-js"))))
      .toBe(resolve("src/commands/plugins/plugin", "..", "..", "..", ".."));

    const symlinkDestSource = createPluginDir(tempRoot, "symlink-dest-source", defaultManifest("symlink-dest"));
    const existingTarget = join(tempRoot, "existing-target");
    mkdirSync(existingTarget, { recursive: true });
    symlinkSync(existingTarget, join(installDir, "symlink-dest"), "dir");
    await expect(installFromDir(symlinkDestSource)).rejects.toThrow(/existing: .*symlink-dest .*existing-target/);

    writeFileSync(join(installDir, ".overrides.json"), JSON.stringify({ "weighted": 9, keep: 2 }));
    const weightedSource = createPluginDir(tempRoot, "weighted-source", { ...defaultManifest("weighted"), weight: 44 });
    mkdirSync(join(installDir, "weighted"), { recursive: true });
    manifestByDir.set(join(installDir, "weighted"), { ...defaultManifest("weighted"), weight: 3 });

    await installFromDir(weightedSource, { force: true });

    expect(JSON.parse(readFileSync(join(installDir, ".overrides.json"), "utf8"))).toEqual({ keep: 2 });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "weighted", linked: true });
  });

  test("tarball installs cover pinned match, pin re-trust, artifact fallback hash, source note, and artifact fallback", async () => {
    lockPlugins["pinned-ok"] = { version: "1.0.0", sha256: "sha256:" + "b".repeat(64), source: "old", added: "old" };
    queueExtract({ manifest: defaultManifest("pinned-ok") });
    await installFromTarball(makeTarball("pinned-ok"), { source: "https://registry.example/pinned-ok.tgz" });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "pinned-ok", sha256: "sha256:" + "a".repeat(64) });
    expect(printCalls.at(-1)?.[3]).toBe("from https://registry.example/pinned-ok.tgz");

    lockPlugins["pin-retrust"] = { version: "1.0.0", sha256: "sha256:" + "c".repeat(64), source: "old", added: "old" };
    pinnedHashOk = false;
    queueExtract({ manifest: defaultManifest("pin-retrust") });
    await installFromTarball(makeTarball("pin-retrust"), { source: "pin-retrust", pin: true });
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "pin-retrust" });
    pinnedHashOk = true;

    const noArtifact = { ...defaultManifest("no-artifact"), artifact: undefined };
    queueExtract({ manifest: noArtifact });
    await installFromTarball(makeTarball("no-artifact"), { source: "no-artifact" });
    expect(recordInstallCalls.at(-1)?.sha256).toMatch(/^sha256:/);
  });



  test("tarball and URL installs cover cross-device copy fallback and download cleanup", async () => {
    const fsForRequire = require("fs") as typeof import("node:fs");
    const originalRenameSync = fsForRequire.renameSync;
    try {
      (fsForRequire as any).renameSync = () => { throw new Error("EXDEV: cross-device link not permitted"); };
      queueExtract({ manifest: defaultManifest("copy-fallback") });
      await installFromTarball(makeTarball("copy-fallback"), { source: "copy-fallback" });
      expect(recordInstallCalls.at(-1)).toMatchObject({ name: "copy-fallback", source: "copy-fallback" });
    } finally {
      (fsForRequire as any).renameSync = originalRenameSync;
    }

    const downloaded = makeTarball("url-cleanup");
    queueDownload({ ok: true, path: downloaded });
    queueExtract({ manifest: defaultManifest("url-cleanup") });
    await installFromUrl("https://registry.example/url-cleanup.tgz");

    expect(downloadCalls.at(-1)).toBe("https://registry.example/url-cleanup.tgz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "url-cleanup", source: "https://registry.example/url-cleanup.tgz" });
    expect(existsSync(join(downloaded, ".."))).toBe(false);
  });

  test("github and monorepo handlers cover default urls, empty latest release, non-sentinel github errors, and download failures", async () => {
    expect(monorepoRepoSlug()).toBe("Soul-Brews-Studio/maw-plugin-registry");
    expect(monorepoTarballUrl("v0.1.0", "owner/registry"))
      .toBe("https://github.com/owner/registry/archive/refs/tags/v0.1.0.tar.gz");

    queueDownload({ ok: false, error: "monorepo unavailable" });
    await expect(installFromMonorepo("plugins/missing", "v0.1.0"))
      .rejects.toThrow(/monorepo unavailable/);

    process.env.MAW_GITHUB_BASE_URL = "https://gh.example";
    latestReleaseStatus = 0;
    latestReleaseStdout = "\n";
    const headTarball = makeTarball("github-head");
    queueDownload({ ok: true, path: headTarball });
    queueExtract({ manifest: defaultManifest("head-tool") });
    await installFromGithub({ owner: "owner", repo: "repo" }, { force: true });
    expect(downloadCalls.at(-1)).toBe("https://gh.example/owner/repo/archive/HEAD.tar.gz");
    expect(recordInstallCalls.at(-1)).toMatchObject({ name: "head-tool", source: "github:owner/repo" });

    const badTarball = makeTarball("github-bad-prefixed");
    queueDownload({ ok: true, path: badTarball });
    queueExtract({ subpaths: { "plugins/tool": sourceManifest("bad-prefixed") } });
    lockPlugins["bad-prefixed"] = { version: "1.0.0", sha256: "sha256:" + "d".repeat(64), source: "old", added: "old" };
    pinnedHashOk = false;
    await expect(installFromGithub({ owner: "owner", repo: "repo", subpath: "tool", ref: "v1" }))
      .rejects.toThrow(/sha256 mismatch/);
  });
});
