/**
 * Phase A installer + loader — cmdPluginInstall, discoverPackages gates,
 * invokePlugin error surfacing. Uses MAW_PLUGINS_DIR to scope each test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { cmdPluginInstall } from "../../src/commands/plugins/plugin/install-impl";
import {
  discoverPackages, invokePlugin, runtimeSdkVersion,
  satisfies, formatSdkMismatchError, __resetDiscoverStateForTests,
  resetDiscoverCache,
} from "../../src/plugin/registry";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;

function tmpDir(prefix = "maw-install-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  // MAW_PLUGINS_DIR overrides ~/.maw/plugins/ in installRoot()+scanDirs().
  const home = tmpDir("maw-home-");
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  // #487 — isolate plugins.lock per test so pins don't leak across cases.
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  __resetDiscoverStateForTests();
  resetDiscoverCache();  // alpha.67 memoization — clear between tests
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

/** Run fn with process.exit + console + process.stderr.write captured.
 *  (Task #2 routes warn/info/error through process.stderr.write; keep the
 *  console.* mocks for tests that call console directly.) */
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
    // Real Error from a handler (post-alpha.57 throw-instead-of-exit pattern):
    // treat as exit 1 and surface the message in stderr so existing assertions hold.
    const msg = String(e?.message ?? "");
    if (!msg.startsWith("__exit__")) {
      if (e instanceof Error && exitCode === undefined) {
        exitCode = 1;
        errs.push(msg);
      } else {
        throw e;
      }
    }
  }
  finally {
    (process as any).exit = o.exit; console.log = o.log;
    console.error = o.err; console.warn = o.warn;
    (process.stderr as any).write = origStderrWrite;
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

/** Build a fake "built" plugin dir + packed tarball. */
function buildFixture(opts: {
  name?: string; version?: string; sdk?: string;
  overrideSha256?: string | null;
} = {}): { dir: string; bundle: string; sha256: string; tarball: string } {
  const name = opts.name ?? "hello";
  const version = opts.version ?? "0.1.0";
  const sdk = opts.sdk ?? "^1.0.0";
  const src = "export default () => ({ ok: true });\n";
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
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json", "index.js"]);
  if (tar.status !== 0) throw new Error("tar failed");
  return { dir, bundle, sha256: sha, tarball };
}

/** Plant a plugin directly under pluginsDir()/<name>/ (real dir). */
function plant(name: string, manifest: Record<string, unknown>, bundle: string): string {
  const dest = join(pluginsDir(), name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "plugin.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dest, "index.js"), bundle);
  return dest;
}

// ─── unit: semver + mismatch error ───────────────────────────────────────────

describe("satisfies + formatSdkMismatchError", () => {
  test("satisfies core ranges", () => {
    expect(satisfies("1.0.0", "*")).toBe(true);
    expect(satisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.0.0", ">=0.9.0")).toBe(true);
    expect(satisfies("1.0.1", "1.0.0")).toBe(false);
  });
  test("formatSdkMismatchError — plan-canonical shape", () => {
    const m = formatSdkMismatchError("hello", "^2.0.0", "1.0.0");
    expect(m).toContain("plugin 'hello'");
    expect(m).toContain("^2.0.0");
    expect(m).toContain("maw update");
    expect(m).toContain("maw plugin install hello@");
    expect(m).toContain("edit plugin.json");
  });
});

// ─── cmdPluginInstall — dir ──────────────────────────────────────────────────

describe("cmdPluginInstall — dir source", () => {
  test("symlinks + prints 'linked (dev)' label", async () => {
    const fx = buildFixture();
    const { exitCode, stdout } = await capture(() => cmdPluginInstall([fx.dir]));
    expect(exitCode).toBeUndefined();
    expect(lstatSync(join(pluginsDir(), "hello")).isSymbolicLink()).toBe(true);
    expect(stdout).toContain("hello@0.1.0 installed");
    expect(stdout).toContain("linked (dev)");
    expect(stdout).toContain("try: maw hello");
  });

  test("replaces an existing install (--force required, #403)", async () => {
    await capture(() => cmdPluginInstall([buildFixture({ version: "0.1.0" }).dir]));

    // #403 — without --force, second install MUST refuse (no silent overwrite).
    const refused = await capture(() => cmdPluginInstall([buildFixture({ version: "0.2.0" }).dir]));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("refusing to overwrite plugin 'hello'");
    // Original 0.1.0 still installed
    const before = JSON.parse(readFileSync(join(pluginsDir(), "hello", "plugin.json"), "utf8"));
    expect(before.version).toBe("0.1.0");

    // With --force, replacement succeeds
    await capture(() => cmdPluginInstall([buildFixture({ version: "0.2.0" }).dir, "--force"]));
    const m = JSON.parse(readFileSync(join(pluginsDir(), "hello", "plugin.json"), "utf8"));
    expect(m.version).toBe("0.2.0");
  });

  test("semver mismatch → exits 1 with canonical error, nothing installed", async () => {
    const major = parseInt(runtimeSdkVersion().split(".")[0]!, 10);
    const fx = buildFixture({ sdk: `^${major + 99}.0.0` });
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([fx.dir]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("plugin 'hello'");
    expect(stderr).toContain(`requires maw SDK ^${major + 99}.0.0`);
    expect(stderr).toContain("maw update");
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("missing source → exits 1", async () => {
    const { exitCode, stderr } = await capture(() => cmdPluginInstall(["/nonexistent/path"]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("source not found");
  });

  test("usage → exits 1 when no args", async () => {
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage:");
  });

  test("#404 — preserve category on replace when new plugin.json omits weight", async () => {
    // Install A with weight=5 (core tier).
    const a = buildFixture({ version: "0.1.0" });
    const aManifest = JSON.parse(readFileSync(join(a.dir, "plugin.json"), "utf8"));
    aManifest.weight = 5;
    writeFileSync(join(a.dir, "plugin.json"), JSON.stringify(aManifest, null, 2));
    await capture(() => cmdPluginInstall([a.dir]));

    // Replace with B — same name, no weight → would default to 50 (extra).
    const b = buildFixture({ version: "0.2.0" });
    await capture(() => cmdPluginInstall([b.dir, "--force"]));

    // Override file stores the preserved weight.
    const overrides = JSON.parse(readFileSync(join(pluginsDir(), ".overrides.json"), "utf8"));
    expect(overrides.hello).toBe(5);

    // Loader applies the override so manifest.weight remains 5.
    const loaded = discoverPackages().find(p => p.manifest.name === "hello");
    expect(loaded?.manifest.weight).toBe(5);
  });

  test("#404 — --category flag overrides preserved weight", async () => {
    await capture(() => cmdPluginInstall([buildFixture({ version: "0.1.0" }).dir]));
    await capture(() => cmdPluginInstall([
      buildFixture({ version: "0.2.0" }).dir, "--force", "--category", "core",
    ]));
    const overrides = JSON.parse(readFileSync(join(pluginsDir(), ".overrides.json"), "utf8"));
    expect(overrides.hello).toBe(5);
  });
});

// ─── cmdPluginInstall — tarball ──────────────────────────────────────────────

describe("cmdPluginInstall — tarball source", () => {
  test("extracts, verifies hash, prints 'installed (sha256:…)' label", async () => {
    const fx = buildFixture();
    // #487 — unpinned installs are refused; test uses --pin to add on the fly.
    const { exitCode, stdout } = await capture(() => cmdPluginInstall([fx.tarball, "--pin"]));
    expect(exitCode).toBeUndefined();
    const dest = join(pluginsDir(), "hello");
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dest, "index.js"))).toBe(true);
    expect(stdout).toContain("installed (sha256:");
  });

  test("hash mismatch → refuses, nothing installed", async () => {
    // Build then tamper the bundle; re-pack with the original (lying) manifest.
    const fx = buildFixture();
    writeFileSync(fx.bundle, "export default () => ({ tampered: true });\n");
    const tampered = join(fx.dir, "tampered.tgz");
    const tar = spawnSync("tar", ["-czf", tampered, "-C", fx.dir, "plugin.json", "index.js"]);
    expect(tar.status).toBe(0);
    // Self-hash fencepost fires before the lock lookup, so --pin is irrelevant here.
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([tampered, "--pin"]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("hash mismatch");
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("unbuilt tarball (sha256:null) → refused", async () => {
    const fx = buildFixture({ overrideSha256: null });
    const { exitCode, stderr } = await capture(() => cmdPluginInstall([fx.tarball, "--pin"]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("sha256=null");
  });
});

// ─── cmdPluginInstall — URL (mocked fetch) ───────────────────────────────────

describe("cmdPluginInstall — URL source (mocked fetch)", () => {
  test("downloads, runs tarball flow, verifies hash", async () => {
    const fx = buildFixture();
    const bytes = readFileSync(fx.tarball);
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "application/gzip" } });
    try {
      // #487 — URL installs require a pinned entry. Pre-pin via the local tarball.
      const { pinPlugin } = await import("../../src/commands/plugins/plugin/lock");
      pinPlugin("hello", fx.tarball);
      const { exitCode, stdout } = await capture(() =>
        cmdPluginInstall(["https://example.com/hello-0.1.0.tgz"]));
      expect(exitCode).toBeUndefined();
      expect(stdout).toContain("installed (sha256:");
      expect(existsSync(join(pluginsDir(), "hello"))).toBe(true);
    } finally { (globalThis as any).fetch = origFetch; }
  });

  test("rejects non-gzip content-type", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    try {
      const { exitCode, stderr } = await capture(() =>
        cmdPluginInstall(["https://evil.example/plugin.html"]));
      expect(exitCode).toBe(1);
      expect(stderr).toContain("content-type");
    } finally { (globalThis as any).fetch = origFetch; }
  });
});

// ─── loader gates ────────────────────────────────────────────────────────────

describe("discoverPackages — gates", () => {
  test("legacy plugin (no artifact) loads with warn-once message", async () => {
    plant("legacy-plugin",
      { name: "legacy-plugin", version: "1.0.0", sdk: "*", entry: "./index.js" },
      "export default () => ({ ok: true });\n");
    const { stderr } = await capture(async () => {
      const plugins = discoverPackages();
      expect(plugins.map(p => p.manifest.name)).toContain("legacy-plugin");
    });
    expect(stderr).toContain("legacy plugin");
  });

  test("semver-mismatched plugin is refused at load", async () => {
    const major = parseInt(runtimeSdkVersion().split(".")[0]!, 10);
    const src = "export default () => ({ ok: true });\n";
    const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
    plant("future-plugin", {
      name: "future-plugin", version: "1.0.0", sdk: `^${major + 42}.0.0`,
      target: "js", capabilities: [], artifact: { path: "./index.js", sha256: sha },
    }, src);
    const { stderr } = await capture(async () => {
      const plugins = discoverPackages();
      expect(plugins.map(p => p.manifest.name)).not.toContain("future-plugin");
    });
    expect(stderr).toContain("future-plugin");
    expect(stderr).toContain("requires maw SDK");
  });

  test("tampered plugin (hash mismatch) is refused at load", async () => {
    const sha = "sha256:" + createHash("sha256")
      .update("export default () => ({ ok: true });\n").digest("hex");
    plant("tampered-plugin", {
      name: "tampered-plugin", version: "1.0.0", sdk: "*",
      target: "js", capabilities: [], artifact: { path: "./index.js", sha256: sha },
    }, "export default () => ({ tampered: true });\n"); // different content
    const { stderr } = await capture(async () => {
      const plugins = discoverPackages();
      expect(plugins.map(p => p.manifest.name)).not.toContain("tampered-plugin");
    });
    expect(stderr).toContain("hash mismatch");
  });

  test("symlink (dev-mode) install skips hash verification", async () => {
    // Manifest claims a fake sha — would be refused if we checked real installs.
    const sourceDir = tmpDir("maw-symlink-src-");
    writeFileSync(join(sourceDir, "plugin.json"), JSON.stringify({
      name: "dev-plugin", version: "1.0.0", sdk: "*",
      target: "js", capabilities: [],
      artifact: { path: "./index.js", sha256: "sha256:" + "0".repeat(64) },
      entry: "./index.js",
    }));
    writeFileSync(join(sourceDir, "index.js"), "export default () => ({ ok: true });\n");
    mkdirSync(pluginsDir(), { recursive: true });
    symlinkSync(sourceDir, join(pluginsDir(), "dev-plugin"), "dir");
    const { stderr } = await capture(async () => {
      const plugins = discoverPackages();
      expect(plugins.map(p => p.manifest.name)).toContain("dev-plugin");
    });
    expect(stderr).not.toContain("hash mismatch");
  });

  test("unbuilt plugin (artifact.sha256=null) is refused with build hint", async () => {
    plant("unbuilt-plugin", {
      name: "unbuilt-plugin", version: "1.0.0", sdk: "*",
      target: "js", capabilities: [], artifact: { path: "./index.js", sha256: null },
    }, "export default () => ({});\n");
    const { stderr } = await capture(async () => {
      const plugins = discoverPackages();
      expect(plugins.map(p => p.manifest.name)).not.toContain("unbuilt-plugin");
    });
    expect(stderr).toContain("unbuilt");
    expect(stderr).toContain("maw plugin build");
  });
});

// ─── invokePlugin: real errors surface (no more process.exit → "exit") ──────

describe("invokePlugin — error surfacing", () => {
  test("real plugin errors surface with stack, not generic 'exit' string", async () => {
    const dir = plant("boom-plugin",
      { name: "boom-plugin", version: "1.0.0", sdk: "*", entry: "./index.js" },
      'export default async function handler(_ctx) {\n' +
      '  throw new Error("boom from plugin");\n}\n');
    await capture(async () => {
      const plugins = discoverPackages();
      const boom = plugins.find(p => p.manifest.name === "boom-plugin");
      expect(boom).toBeDefined();
      const result = await invokePlugin(boom!, { source: "cli", args: [] });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("boom from plugin");
      // Stack should reference the plugin source path (Bun source maps).
      expect(result.error).toContain(dir);
      // The old monkey-patch surfaced "exit" — we must NOT see that.
      expect(result.error).not.toBe("exit");
    });
  });
});
