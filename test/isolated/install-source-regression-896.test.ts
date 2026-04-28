/**
 * #896 — install regression tests for post-#880 source-plugin paths.
 *
 * #880 (path A.3) made `installFromTarball` accept entry-only manifests so
 * community plugins (cross-team-queue, shellenv, bg, rename, park) — which
 * ship src/ + plugin.json with no dist/ and no artifact — install natively.
 *
 * #896 reported the regression still occurred against alpha.39 + v0.1.2
 * plugins. Investigation surfaced two defensive gaps the original tests did
 * not cover:
 *
 *   1. GitHub-archive-wrapped source plugins. Live registry sources use
 *      `github:OWNER/REPO#REF` which github serves as `<repo>-<ref>/`-wrapped
 *      tarballs. #864 added `findPluginRoot` to walk one level into wrapper
 *      dirs, but #880's source-plugin tests build flat fixtures only — the
 *      wrapper-walk + entry-only paths were never exercised together.
 *
 *   2. Half-built manifests — `artifact.sha256: null` + valid `entry`.
 *      parseManifest accepts `sha256: null` (signals "unbuilt"). Pre-#896
 *      `verifyArtifactHash` saw the truthy `manifest.artifact`, fell through
 *      `isSourcePluginManifest` (which required no-artifact), and hit the
 *      `sha256===null` fencepost — even when a perfectly valid `entry` was
 *      right there. The user-facing message ("rebuild with `maw plugin build`")
 *      matches #896's reported symptom regardless of which branch tripped it.
 *
 * Both gaps now route through `isSourcePluginManifest`, which after #896
 * accepts EITHER no-artifact OR half-built (artifact.sha256===null) when
 * `entry` is present.
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
import { cmdPluginInstall } from "../../src/commands/plugins/plugin/install-impl";
import {
  isSourcePluginManifest,
  verifyArtifactHash,
  verifyArtifactHashAgainst,
} from "../../src/commands/plugins/plugin/install-extraction";
import {
  __resetDiscoverStateForTests,
  resetDiscoverCache,
} from "../../src/plugin/registry";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;

function tmpDir(prefix = "maw-896-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  const home = tmpDir("maw-896-home-");
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
      if (e instanceof Error && exitCode === undefined) {
        exitCode = 1;
        errs.push(msg);
      } else {
        throw e;
      }
    }
  } finally {
    (process as any).exit = o.exit; console.log = o.log;
    console.error = o.err; console.warn = o.warn;
    (process.stderr as any).write = origStderrWrite;
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

// ─── Fixture builders ────────────────────────────────────────────────────────

/**
 * Build a github-archive-style tarball (path #864 + #880 combined).
 * The tarball wraps plugin.json + src/index.ts inside `<repo>-<ref>/`,
 * matching what `github:OWNER/REPO#v0.1.2` registry sources resolve to
 * via `https://github.com/OWNER/REPO/archive/refs/tags/v0.1.2.tar.gz`.
 */
function buildWrappedSourceFixture(opts: {
  name?: string;
  version?: string;
  wrapperName?: string;
  capabilities?: string[];
} = {}): { tarball: string; sha256: string } {
  const name = opts.name ?? "wrapped-src";
  const version = opts.version ?? "0.1.2";
  const wrapperName = opts.wrapperName ?? `${name}-${version}`;
  const dir = tmpDir("maw-896-wrapped-");
  const wrapper = join(dir, wrapperName);
  const srcDir = join(wrapper, "src");
  mkdirSync(srcDir, { recursive: true });
  const src = "export default () => ({ ok: true });\n";
  writeFileSync(join(srcDir, "index.ts"), src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  const manifest: Record<string, unknown> = {
    $schema: "https://maw.soulbrews.studio/schema/plugin.json",
    name,
    version,
    sdk: "^1.0.0-alpha",
    target: "js",
    capabilities: opts.capabilities ?? [],
    schemaVersion: 1,
    entry: "./src/index.ts",
  };
  writeFileSync(join(wrapper, "plugin.json"), JSON.stringify(manifest, null, 2));
  const tarball = join(dir, `${name}.tgz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, wrapperName]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { tarball, sha256: sha };
}

/**
 * Build a half-built source fixture: plugin.json declares both `entry` and
 * `artifact` but the artifact's sha256 is null (unbuilt) and the artifact
 * path may or may not exist on disk. parseManifest accepts this shape.
 *
 * Pre-#896 this tarball would hit `verifyArtifactHash`'s sha256===null
 * fencepost and reject — even though `entry` was perfectly valid.
 */
function buildHalfBuiltFixture(opts: {
  name?: string;
  artifactExists?: boolean;
} = {}): { tarball: string; entrySha256: string } {
  const name = opts.name ?? "half-built";
  const artifactExists = opts.artifactExists ?? false;
  const dir = tmpDir("maw-896-halfbuilt-");
  const src = "export default () => ({ ok: true });\n";
  writeFileSync(join(dir, "index.ts"), src);
  if (artifactExists) {
    writeFileSync(join(dir, "stub.js"), "// pre-build placeholder\n");
  }
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  const manifest: Record<string, unknown> = {
    name,
    version: "0.1.0",
    sdk: "^1.0.0",
    target: "js",
    capabilities: [],
    entry: "./index.ts",
    artifact: { path: "./stub.js", sha256: null },
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  const tarball = join(dir, `${name}.tgz`);
  const files = artifactExists
    ? ["plugin.json", "index.ts", "stub.js"]
    : ["plugin.json", "index.ts"];
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, ...files]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { tarball, entrySha256: sha };
}

// ─── A. github-archive-wrapped source plugins (#864 + #880 combined) ─────────

describe("#896 — github-archive-wrapped source plugins install end-to-end", () => {
  test("v0.1.2-style wrapped source tarball installs without 'no artifact field' rejection", async () => {
    const fx = buildWrappedSourceFixture({
      name: "shellenv-like",
      version: "0.1.2",
      wrapperName: "maw-shellenv-v0.1.2",
    });
    const { exitCode, stdout, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    // The exact symptom from #896.
    expect(stderr).not.toContain("tarball manifest has no 'artifact' field");
    expect(stderr).not.toContain("rebuild with `maw plugin build`");
    expect(existsSync(join(pluginsDir(), "shellenv-like"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "shellenv-like", "src", "index.ts"))).toBe(true);
    expect(stdout).toContain("shellenv-like@0.1.2 installed");
  });

  test("wrapped source plugin records entry-file sha into plugins.lock", async () => {
    const fx = buildWrappedSourceFixture({ name: "wrapped-lock", version: "0.1.2" });
    const { exitCode } = await capture(() => cmdPluginInstall([fx.tarball, "--pin"]));
    expect(exitCode).toBeUndefined();
    const lock = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(lock.plugins["wrapped-lock"]).toBeDefined();
    expect(lock.plugins["wrapped-lock"].sha256).toBe(fx.entrySha256 ?? fx.sha256);
  });

  test("wrapped source plugin with capabilities=['tmux'] installs cleanly", async () => {
    const fx = buildWrappedSourceFixture({
      name: "wrapped-tmux",
      version: "0.1.2",
      capabilities: ["tmux"],
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain('unknown capability namespace "tmux"');
    expect(stderr).not.toContain("no 'artifact'");
  });
});

// ─── B. half-built manifests (artifact.sha256===null + entry) ────────────────

describe("#896 — half-built manifests fall through to entry", () => {
  test("isSourcePluginManifest accepts no-artifact + entry (path A.3 canonical)", () => {
    expect(
      isSourcePluginManifest({
        name: "x", version: "1.0.0", sdk: "^1.0.0",
        entry: "./src/index.ts",
      } as any),
    ).toBe(true);
  });

  test("isSourcePluginManifest accepts artifact.sha256===null + entry (#896 half-built)", () => {
    expect(
      isSourcePluginManifest({
        name: "x", version: "1.0.0", sdk: "^1.0.0",
        entry: "./src/index.ts",
        artifact: { path: "./dist/index.js", sha256: null },
      } as any),
    ).toBe(true);
  });

  test("isSourcePluginManifest rejects fully-built (artifact.sha256 set)", () => {
    expect(
      isSourcePluginManifest({
        name: "x", version: "1.0.0", sdk: "^1.0.0",
        entry: "./src/index.ts",
        artifact: { path: "./dist/index.js", sha256: "sha256:abc" },
      } as any),
    ).toBe(false);
  });

  test("isSourcePluginManifest rejects no-entry manifests", () => {
    expect(
      isSourcePluginManifest({ name: "x", version: "1.0.0", sdk: "^1.0.0" } as any),
    ).toBe(false);
  });

  test("verifyArtifactHash accepts half-built when entry exists on disk", () => {
    const fx = buildHalfBuiltFixture({ name: "verify-half", artifactExists: false });
    // Extract the tarball into a staging dir to mirror installFromTarball.
    const staging = tmpDir("maw-896-stage-");
    const tar = spawnSync("tar", ["-xzf", fx.tarball, "-C", staging]);
    expect(tar.status).toBe(0);
    const { readFileSync: rfs } = require("fs");
    const m = JSON.parse(rfs(join(staging, "plugin.json"), "utf8"));
    const result = verifyArtifactHash(staging, m);
    expect(result.ok).toBe(true);
  });

  test("half-built tarball installs end-to-end (entry rescues sha256:null)", async () => {
    const fx = buildHalfBuiltFixture({ name: "half-install", artifactExists: false });
    const { exitCode, stdout, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain("no 'artifact' field");
    expect(stderr).not.toContain("artifact.sha256=null");
    expect(stdout).toContain("half-install@0.1.0 installed");
    const lock = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(lock.plugins["half-install"].sha256).toBe(fx.entrySha256);
  });

  test("verifyArtifactHashAgainst falls back to entry when artifact path missing on disk", () => {
    const fx = buildHalfBuiltFixture({ name: "verify-against", artifactExists: false });
    const staging = tmpDir("maw-896-stage-");
    const tar = spawnSync("tar", ["-xzf", fx.tarball, "-C", staging]);
    expect(tar.status).toBe(0);
    const m = JSON.parse(readFileSync(join(staging, "plugin.json"), "utf8"));
    // isSourcePluginManifest is true (sha256:null + entry), so the function
    // hashes entry bytes, not the missing artifact path.
    const result = verifyArtifactHashAgainst(staging, m, fx.entrySha256);
    expect(result.ok).toBe(true);
  });
});

// ─── C. error-message disambiguation ─────────────────────────────────────────

describe("#896 — error messages disambiguate the artifact-vs-entry decision", () => {
  test("manifest with neither artifact nor entry → mentions BOTH options in error", async () => {
    const dir = tmpDir("maw-896-naked-");
    const manifest = { name: "naked-896", version: "0.1.0", sdk: "^1.0.0" };
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
    const tarball = join(dir, "naked.tgz");
    spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json"]);
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([tarball, "--pin"]),
    );
    expect(exitCode).toBe(1);
    // Post-#896, the message lists BOTH the artifact AND entry remediation
    // — so a future filer can tell which branch tripped without diving into
    // source. (The pre-#896 message only suggested `maw plugin build`.)
    expect(stderr).toContain("entry");
    expect(stderr).toContain("artifact");
  });
});
