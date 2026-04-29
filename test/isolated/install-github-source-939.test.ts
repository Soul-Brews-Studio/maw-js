/**
 * github: source resolver — #939 Vercel-style `owner/repo[/name][@ref]`.
 *
 * Adds a github source kind to the install resolver:
 *
 *   maw plugin install nazt/my-plugin
 *   maw plugin install Soul-Brews-Studio/maw-plugins/bg
 *   maw plugin install nazt/my-plugin@v1.2.3
 *   maw plugin install Soul-Brews-Studio/maw-plugins/bg@v0.1.2
 *
 * Mirrors Vercel's `npx skills add owner/repo` pattern (registry becomes a
 * discovery layer over GitHub, not a custom packaging format).
 *
 * Coverage:
 *   • parseGithubRef happy paths (4 shapes)
 *   • parseGithubRef rejects: bare name, url, tarball, peer-shape, leading
 *     `./` `../` `/`, `monorepo:` prefix, double-slash, invalid segment chars
 *   • detectMode precedence: url, tarball, peer, monorepo, dir each win when
 *     applicable
 *   • githubTarballUrl shapes (HEAD, tag-shaped ref, branch ref, env override)
 *   • End-to-end installFromTarball with the github subpath layout produces
 *     a working install.
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
  parseGithubRef,
  detectMode,
  installFromTarball,
  githubTarballUrl,
  githubBaseUrl,
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
let origGithubBase: string | undefined;

function tmpDir(prefix = "maw-gh-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  origGithubBase = process.env.MAW_GITHUB_BASE_URL;
  const home = tmpDir("maw-gh-home-");
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
  if (origGithubBase !== undefined) process.env.MAW_GITHUB_BASE_URL = origGithubBase;
  else delete process.env.MAW_GITHUB_BASE_URL;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── parseGithubRef — positive cases ─────────────────────────────────────────

describe("parseGithubRef — positive cases", () => {
  test("owner/repo parses to owner + repo", () => {
    expect(parseGithubRef("nazt/my-plugin")).toEqual({
      owner: "nazt",
      repo: "my-plugin",
    });
  });

  test("owner/repo/name extracts the trailing name segment", () => {
    expect(parseGithubRef("Soul-Brews-Studio/maw-plugins/bg")).toEqual({
      owner: "soul-brews-studio",
      repo: "maw-plugins",
      name: "bg",
    });
  });

  test("owner/repo@ref extracts ref without name", () => {
    expect(parseGithubRef("nazt/my-plugin@v1.2.3")).toEqual({
      owner: "nazt",
      repo: "my-plugin",
      ref: "v1.2.3",
    });
  });

  test("owner/repo/name@ref extracts all four fields", () => {
    expect(parseGithubRef("Soul-Brews-Studio/maw-plugins/bg@v0.1.2")).toEqual({
      owner: "soul-brews-studio",
      repo: "maw-plugins",
      name: "bg",
      ref: "v0.1.2",
    });
  });

  test("owner + repo are normalized to lowercase (GitHub is case-insensitive)", () => {
    const r = parseGithubRef("NAZT/My-Plugin@v1.0.0")!;
    expect(r.owner).toBe("nazt");
    expect(r.repo).toBe("my-plugin");
    // ref preserved verbatim (git refs are case-sensitive).
    expect(r.ref).toBe("v1.0.0");
  });

  test("name (subpath) preserved verbatim — filesystem paths are case-sensitive", () => {
    const r = parseGithubRef("owner/repo/MixedCase-Name")!;
    expect(r.name).toBe("MixedCase-Name");
  });

  test("multi-segment subpath kept as literal slash-joined path", () => {
    expect(parseGithubRef("owner/repo/plugins/deep/nested")).toEqual({
      owner: "owner",
      repo: "repo",
      name: "plugins/deep/nested",
    });
  });

  test("ref may contain dots and hyphens (semver pre-release shapes)", () => {
    expect(parseGithubRef("owner/repo@v1.2.3-rc.4")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "v1.2.3-rc.4",
    });
  });
});

// ─── parseGithubRef — negative cases ─────────────────────────────────────────

describe("parseGithubRef — negative cases (other modes win)", () => {
  test("bare name (no slash) returns null — would be dir mode", () => {
    expect(parseGithubRef("my-plugin")).toBeNull();
  });

  test("http/https URLs return null", () => {
    expect(parseGithubRef("https://github.com/owner/repo")).toBeNull();
    expect(parseGithubRef("http://example.com/a/b")).toBeNull();
  });

  test(".tgz / .tar.gz tarball paths return null", () => {
    expect(parseGithubRef("./pkg/foo.tgz")).toBeNull();
    expect(parseGithubRef("owner/repo.tar.gz")).toBeNull();
  });

  test("explicit relative paths return null (./ and ../)", () => {
    expect(parseGithubRef("./owner/repo")).toBeNull();
    expect(parseGithubRef("../owner/repo")).toBeNull();
  });

  test("absolute paths return null", () => {
    expect(parseGithubRef("/var/plugins/owner/repo")).toBeNull();
  });

  test("monorepo: prefix returns null (existing mode wins)", () => {
    expect(parseGithubRef("monorepo:plugins/bg@v0.1.2")).toBeNull();
  });

  test("github: prefix returns null (avoid double-claim)", () => {
    expect(parseGithubRef("github:owner/repo")).toBeNull();
  });

  test("empty owner or repo returns null", () => {
    expect(parseGithubRef("/repo")).toBeNull();
    expect(parseGithubRef("owner/")).toBeNull();
    expect(parseGithubRef("//repo")).toBeNull();
  });

  test("invalid characters in owner/repo return null", () => {
    expect(parseGithubRef("own er/repo")).toBeNull();
    expect(parseGithubRef("owner/re po")).toBeNull();
  });

  test("empty ref returns null", () => {
    expect(parseGithubRef("owner/repo@")).toBeNull();
  });

  test("subpath containing .. segment returns null", () => {
    expect(parseGithubRef("owner/repo/..")).toBeNull();
    expect(parseGithubRef("owner/repo/foo/../etc")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(parseGithubRef("")).toBeNull();
  });
});

// ─── detectMode — precedence guarantees ──────────────────────────────────────

describe("detectMode — github branch + precedence", () => {
  test("returns kind:github for a bare owner/repo", () => {
    const m = detectMode("nazt/my-plugin");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.owner).toBe("nazt");
      expect(m.repo).toBe("my-plugin");
      expect(m.src).toBe("nazt/my-plugin");
    }
  });

  test("returns kind:github with name + ref for owner/repo/name@ref", () => {
    const m = detectMode("Soul-Brews-Studio/maw-plugins/bg@v0.1.2");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      expect(m.owner).toBe("soul-brews-studio");
      expect(m.repo).toBe("maw-plugins");
      expect(m.name).toBe("bg");
      expect(m.ref).toBe("v0.1.2");
    }
  });

  test("URL still wins over github (https://… stays kind:url)", () => {
    expect(detectMode("https://github.com/owner/repo/archive/HEAD.tar.gz").kind).toBe("url");
  });

  test("tarball extension wins over github (foo/bar.tgz stays kind:tarball)", () => {
    // Note: ./ is added so resolve() doesn't escape cwd; this still exercises
    // the .tgz branch winning over github-shape detection.
    expect(detectMode("./owner/repo.tgz").kind).toBe("tarball");
  });

  test("monorepo: prefix wins over github (existing kind:monorepo preserved)", () => {
    const m = detectMode("monorepo:plugins/bg@v0.1.2-bg");
    expect(m.kind).toBe("monorepo");
  });

  test("peer name@host (no slash) stays kind:peer", () => {
    expect(detectMode("ping@white").kind).toBe("peer");
  });

  test("explicit relative path stays kind:dir even when shaped like owner/repo", () => {
    expect(detectMode("./owner/repo").kind).toBe("dir");
  });

  test("bare name with no slash stays kind:dir (legacy behavior)", () => {
    expect(detectMode("my-plugin").kind).toBe("dir");
  });
});

// ─── githubTarballUrl — URL construction ────────────────────────────────────

describe("githubTarballUrl — URL shapes", () => {
  test("no ref → archive/HEAD.tar.gz", () => {
    delete process.env.MAW_GITHUB_BASE_URL;
    expect(githubTarballUrl("nazt", "my-plugin")).toBe(
      "https://github.com/nazt/my-plugin/archive/HEAD.tar.gz",
    );
  });

  test("tag-shaped ref (v…) → archive/refs/tags/<ref>.tar.gz", () => {
    delete process.env.MAW_GITHUB_BASE_URL;
    expect(githubTarballUrl("owner", "repo", "v1.2.3")).toBe(
      "https://github.com/owner/repo/archive/refs/tags/v1.2.3.tar.gz",
    );
  });

  test("branch ref (non-v) → archive/<ref>.tar.gz (bare)", () => {
    delete process.env.MAW_GITHUB_BASE_URL;
    expect(githubTarballUrl("owner", "repo", "main")).toBe(
      "https://github.com/owner/repo/archive/main.tar.gz",
    );
  });

  test("MAW_GITHUB_BASE_URL overrides host", () => {
    process.env.MAW_GITHUB_BASE_URL = "http://localhost:9999";
    expect(githubTarballUrl("owner", "repo", "v1.0.0")).toBe(
      "http://localhost:9999/owner/repo/archive/refs/tags/v1.0.0.tar.gz",
    );
    expect(githubBaseUrl()).toBe("http://localhost:9999");
  });
});

// ─── End-to-end install via installFromTarball + github layout ──────────────
//
// We reuse the same monorepo-style fixture as the registry tests: github
// archives wrap contents in `<repo>-<ref>/`, and when a `name` is supplied
// the resolver descends into `plugins/<name>/`. Hitting installFromTarball
// directly with the synthesized subpath keeps the test offline.

function buildGithubFixture(opts: {
  owner: string;
  repo: string;
  name: string;
  ref: string;
  version: string;
}): { tarball: string; entrySha256: string } {
  const wrapper = `${opts.repo}-${opts.ref}`;
  const dir = tmpDir("maw-gh-fx-");
  const wrapperDir = join(dir, wrapper);
  const pluginDir = join(wrapperDir, "plugins", opts.name);
  const srcDir = join(pluginDir, "src");
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(join(wrapperDir, "README.md"), `# ${opts.repo}\n`);
  const src = `export default () => ({ ok: "${opts.name}" });\n`;
  writeFileSync(join(srcDir, "index.ts"), src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");

  const manifest = {
    $schema: "https://maw.soulbrews.studio/schema/plugin.json",
    name: opts.name,
    version: opts.version,
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
  return { tarball, entrySha256: sha };
}

describe("installFromTarball — github source layout (offline)", () => {
  test("installs plugin via owner/repo/name layout", async () => {
    const fx = buildGithubFixture({
      owner: "soul-brews-studio",
      repo: "maw-plugins",
      name: "bg",
      ref: "v0.1.2",
      version: "0.1.2",
    });
    await installFromTarball(fx.tarball, {
      source: "soul-brews-studio/maw-plugins/bg@v0.1.2",
      subpath: "plugins/bg",
      pin: true,
    });
    expect(existsSync(join(pluginsDir(), "bg"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "bg", "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "bg", "src", "index.ts"))).toBe(true);
  });

  test("records github source string into plugins.lock", async () => {
    const fx = buildGithubFixture({
      owner: "nazt",
      repo: "maw-plugins",
      name: "rename",
      ref: "v0.2.0",
      version: "0.2.0",
    });
    await installFromTarball(fx.tarball, {
      source: "nazt/maw-plugins/rename@v0.2.0",
      subpath: "plugins/rename",
      pin: true,
    });
    const lock = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(lock.plugins["rename"]).toBeDefined();
    expect(lock.plugins["rename"].source).toBe("nazt/maw-plugins/rename@v0.2.0");
    expect(lock.plugins["rename"].sha256).toBe(fx.entrySha256);
  });
});

// ─── detectMode round-trip with parseGithubRef ───────────────────────────────

describe("detectMode round-trip with parseGithubRef", () => {
  test("kind:github carries through owner/repo/name/ref verbatim from parser", () => {
    const m = detectMode("Soul-Brews-Studio/maw-plugins/bg@v0.1.2");
    expect(m.kind).toBe("github");
    if (m.kind === "github") {
      const parsed = parseGithubRef(m.src)!;
      expect(parsed.owner).toBe(m.owner);
      expect(parsed.repo).toBe(m.repo);
      expect(parsed.name).toBe(m.name);
      expect(parsed.ref).toBe(m.ref);
    }
  });
});
