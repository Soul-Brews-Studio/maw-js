/**
 * monorepo: source resolver — end-to-end install (registry#2).
 *
 * Covers the new `monorepo:plugins/<name>@<tag>` source format added to
 * maw plugin install. The resolver downloads the tagged monorepo tarball,
 * walks into the github wrapper, descends into `plugins/<name>/`, and from
 * there reuses the existing readManifest + sha256-verify + install flow.
 *
 * The tests below build a fixture tarball whose layout mirrors what github
 * serves for `https://github.com/<org>/maw-plugin-registry/archive/refs/
 * tags/v0.1.2-shellenv.tar.gz`:
 *
 *   maw-plugin-registry-v0.1.2-shellenv/
 *     plugins/
 *       shellenv/
 *         plugin.json
 *         src/index.ts
 *     other-files...
 *
 * We exercise installFromTarball directly with `subpath: "plugins/<name>"`
 * (the same call shape installFromMonorepo makes after download) — that
 * keeps the test offline while still hitting the new wrapper + subpath
 * code path. parseMonorepoRef + monorepoTarballUrl are exercised as
 * separate units.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import {
  installFromTarball,
  parseMonorepoRef,
  detectMode,
  monorepoTarballUrl,
  monorepoRepoSlug,
  findMonorepoPluginRoot,
  ensureInstallRoot,
} from "../../src/commands/plugins/plugin/install-impl";
import {
  __resetDiscoverStateForTests,
  resetDiscoverCache,
} from "../../src/plugin/registry";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;
let origMonorepoRepo: string | undefined;
let origMonorepoBase: string | undefined;

function tmpDir(prefix = "maw-monorepo-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  origMonorepoRepo = process.env.MAW_MONOREPO_REGISTRY_REPO;
  origMonorepoBase = process.env.MAW_MONOREPO_BASE_URL;
  const home = tmpDir("maw-monorepo-home-");
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  ensureInstallRoot();
  __resetDiscoverStateForTests();
  resetDiscoverCache();
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  if (origPluginsLock !== undefined) process.env.MAW_PLUGINS_LOCK = origPluginsLock;
  else delete process.env.MAW_PLUGINS_LOCK;
  if (origMonorepoRepo !== undefined) process.env.MAW_MONOREPO_REGISTRY_REPO = origMonorepoRepo;
  else delete process.env.MAW_MONOREPO_REGISTRY_REPO;
  if (origMonorepoBase !== undefined) process.env.MAW_MONOREPO_BASE_URL = origMonorepoBase;
  else delete process.env.MAW_MONOREPO_BASE_URL;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── Fixture builder ─────────────────────────────────────────────────────────

/**
 * Build a github-archive-style monorepo tarball:
 *   <wrapper>/plugins/<name>/{plugin.json, src/index.ts}
 *   <wrapper>/README.md   (sibling files at the repo root, like a real monorepo)
 */
function buildMonorepoFixture(opts: {
  pluginName?: string;
  version?: string;
  tag?: string;
  repoSlug?: string;
} = {}): { tarball: string; wrapper: string; entrySha256: string } {
  const pluginName = opts.pluginName ?? "shellenv";
  const version = opts.version ?? "0.1.2";
  const tag = opts.tag ?? `v${version}-${pluginName}`;
  const repoBase = (opts.repoSlug ?? "Soul-Brews-Studio/maw-plugin-registry").split("/").pop()!;
  const wrapper = `${repoBase}-${tag}`;

  const dir = tmpDir("maw-monorepo-fx-");
  const wrapperDir = join(dir, wrapper);
  const pluginDir = join(wrapperDir, "plugins", pluginName);
  const srcDir = join(pluginDir, "src");
  mkdirSync(srcDir, { recursive: true });

  // Sibling repo files — proves the resolver doesn't get confused by
  // non-plugin contents at the repo root.
  writeFileSync(join(wrapperDir, "README.md"), "# maw-plugin-registry monorepo\n");
  writeFileSync(join(wrapperDir, "package.json"), '{"name":"maw-plugin-registry"}\n');

  const src = "export default () => ({ ok: true });\n";
  writeFileSync(join(srcDir, "index.ts"), src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");

  const manifest = {
    $schema: "https://maw.soulbrews.studio/schema/plugin.json",
    name: pluginName,
    version,
    sdk: "^1.0.0-alpha",
    target: "js",
    capabilities: [],
    schemaVersion: 1,
    entry: "./src/index.ts",
  };
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  const tarball = join(dir, `${wrapper}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, wrapper]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { tarball, wrapper, entrySha256: sha };
}

// ─── monorepoTarballUrl + monorepoRepoSlug — env override behavior ───────────

describe("monorepoTarballUrl — URL construction", () => {
  test("default repo + base produces canonical github archive URL", () => {
    delete process.env.MAW_MONOREPO_REGISTRY_REPO;
    delete process.env.MAW_MONOREPO_BASE_URL;
    expect(monorepoTarballUrl("v0.1.2-shellenv")).toBe(
      "https://github.com/Soul-Brews-Studio/maw-plugin-registry/archive/refs/tags/v0.1.2-shellenv.tar.gz",
    );
  });

  test("MAW_MONOREPO_REGISTRY_REPO overrides repo slug", () => {
    process.env.MAW_MONOREPO_REGISTRY_REPO = "fork/maw-plugin-registry";
    expect(monorepoTarballUrl("v1.0.0")).toBe(
      "https://github.com/fork/maw-plugin-registry/archive/refs/tags/v1.0.0.tar.gz",
    );
    expect(monorepoRepoSlug()).toBe("fork/maw-plugin-registry");
  });

  test("MAW_MONOREPO_BASE_URL overrides host (for tests / mirrors)", () => {
    process.env.MAW_MONOREPO_BASE_URL = "http://localhost:9999";
    expect(monorepoTarballUrl("v1.0.0", "owner/repo")).toBe(
      "http://localhost:9999/owner/repo/archive/refs/tags/v1.0.0.tar.gz",
    );
  });

  test("explicit repo arg wins over env override", () => {
    process.env.MAW_MONOREPO_REGISTRY_REPO = "env/wins-not";
    expect(monorepoTarballUrl("v1", "explicit/wins")).toContain("explicit/wins");
  });
});

// ─── findMonorepoPluginRoot — extraction-dir walking ─────────────────────────

describe("findMonorepoPluginRoot — wrapper + subpath walk", () => {
  test("walks into single-dir wrapper and then into subpath", () => {
    const fx = buildMonorepoFixture({ pluginName: "bg", version: "0.1.0" });
    const staging = tmpDir("maw-monorepo-stage-");
    const tar = spawnSync("tar", ["-xzf", fx.tarball, "-C", staging]);
    expect(tar.status).toBe(0);

    const root = findMonorepoPluginRoot(staging, "plugins/bg");
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, "plugin.json"))).toBe(true);
    expect(existsSync(join(root!, "src", "index.ts"))).toBe(true);
  });

  test("handles already-flat staging (no wrapper) — descends straight into subpath", () => {
    const dir = tmpDir("maw-monorepo-flat-");
    const pluginDir = join(dir, "plugins", "rename");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), '{"name":"rename","version":"0.1.0","sdk":"^1.0.0-alpha"}');

    const root = findMonorepoPluginRoot(dir, "plugins/rename");
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, "plugin.json"))).toBe(true);
  });

  test("returns null when subpath does not contain plugin.json", () => {
    const fx = buildMonorepoFixture({ pluginName: "shellenv", version: "0.1.2" });
    const staging = tmpDir("maw-monorepo-stage-");
    spawnSync("tar", ["-xzf", fx.tarball, "-C", staging]);
    expect(findMonorepoPluginRoot(staging, "plugins/nonexistent")).toBeNull();
  });
});

// ─── End-to-end install via installFromTarball + subpath ─────────────────────

describe("installFromTarball — monorepo subpath extraction", () => {
  test("installs plugin from monorepo-style wrapper + plugins/<name>/ subpath", async () => {
    const fx = buildMonorepoFixture({
      pluginName: "shellenv",
      version: "0.1.2",
      tag: "v0.1.2-shellenv",
    });
    await installFromTarball(fx.tarball, {
      source: "monorepo:plugins/shellenv@v0.1.2-shellenv",
      subpath: "plugins/shellenv",
      pin: true,
    });
    expect(existsSync(join(pluginsDir(), "shellenv"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "shellenv", "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "shellenv", "src", "index.ts"))).toBe(true);

    // README.md from the repo root must NOT have been moved into the install
    // dir — the resolver should descend into plugins/<name>/ only.
    expect(existsSync(join(pluginsDir(), "shellenv", "README.md"))).toBe(false);
  });

  test("records monorepo: source string into plugins.lock", async () => {
    const fx = buildMonorepoFixture({ pluginName: "bg", version: "0.1.0", tag: "v0.1.0-bg" });
    await installFromTarball(fx.tarball, {
      source: "monorepo:plugins/bg@v0.1.0-bg",
      subpath: "plugins/bg",
      pin: true,
    });
    const lock = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(lock.plugins["bg"]).toBeDefined();
    expect(lock.plugins["bg"].source).toBe("monorepo:plugins/bg@v0.1.0-bg");
    expect(lock.plugins["bg"].sha256).toBe(fx.entrySha256);
  });

  test("clear error when subpath doesn't exist in tarball", async () => {
    const fx = buildMonorepoFixture({ pluginName: "shellenv", version: "0.1.2" });
    await expect(
      installFromTarball(fx.tarball, {
        source: "monorepo:plugins/missing@v0.1.2",
        subpath: "plugins/missing",
        pin: true,
      }),
    ).rejects.toThrow(/no plugin\.json at subpath 'plugins\/missing'/);
  });
});

// ─── detectMode + parseMonorepoRef integration smoke ─────────────────────────

describe("detectMode round-trip with parseMonorepoRef", () => {
  test("detectMode → monorepo kind carries through subpath + tag verbatim", () => {
    const m = detectMode("monorepo:plugins/park@v0.2.0-park");
    expect(m.kind).toBe("monorepo");
    if (m.kind === "monorepo") {
      const parsed = parseMonorepoRef(m.src)!;
      expect(parsed.subpath).toBe(m.subpath);
      expect(parsed.tag).toBe(m.tag);
    }
  });
});
