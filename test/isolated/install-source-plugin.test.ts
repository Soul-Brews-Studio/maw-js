/**
 * #874 — install supports source plugins natively (path A.3) +
 *        tmux / shell capability namespaces.
 *
 * Two architectural sub-issues from #874:
 *
 *   A. Source vs built tarball — community repos (cross-team-queue, shellenv,
 *      bg, rename, park) ship `src/index.ts` + `plugin.json` with no `dist/`
 *      and no `manifest.artifact`. Pre-#874 the install path required
 *      `manifest.artifact` and rejected with
 *      `tarball manifest has no 'artifact' field — rebuild with maw plugin build`.
 *      Path A.3: install accepts `entry`-only manifests; the entry file IS
 *      the artifact for source plugins (Bun executes .ts/.js source directly).
 *
 *   B. Capability namespaces — `tmux` and `shell` joined the seeded list so
 *      bg/rename/park/shellenv plugin.json files no longer trigger
 *      `unknown capability namespace "tmux"` warnings during validation.
 *
 * Tests cover both paths + backwards compat + invalid-namespace rejection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync, lstatSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { cmdPluginInstall } from "../../src/commands/plugins/plugin/install-impl";
import {
  __resetDiscoverStateForTests,
  resetDiscoverCache,
} from "../../src/plugin/registry";
import {
  KNOWN_CAPABILITY_NAMESPACES,
  parseManifest,
} from "../../src/plugin/manifest";

// ─── Harness (mirrors plugin-install.test.ts) ────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;

function tmpDir(prefix = "maw-source-install-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  const home = tmpDir("maw-home-");
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

/** Capture stdout/stderr/exit identically to the existing install tests. */
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
  }
  finally {
    (process as any).exit = o.exit; console.log = o.log;
    console.error = o.err; console.warn = o.warn;
    (process.stderr as any).write = origStderrWrite;
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

/**
 * Build a SOURCE-plugin tarball (path A.3): plugin.json declares `entry` but
 * no `artifact`. Mirrors what community repos publish (src/index.ts +
 * plugin.json, no dist/).
 */
function buildSourceFixture(opts: {
  name?: string; version?: string; sdk?: string;
  capabilities?: string[];
  entry?: string;
  source?: string;
} = {}): { dir: string; entryPath: string; sha256: string; tarball: string; entryRel: string } {
  const name = opts.name ?? "src-hello";
  const version = opts.version ?? "0.1.0";
  const sdk = opts.sdk ?? "^1.0.0";
  const entryRel = opts.entry ?? "./index.ts";
  const src = opts.source ?? "export default () => ({ ok: true });\n";
  const dir = tmpDir("maw-source-fixture-");
  const entryPath = join(dir, entryRel.replace(/^\.\//, ""));
  // Support nested entries like ./src/index.ts
  const parent = join(entryPath, "..");
  if (!existsSync(parent)) {
    spawnSync("mkdir", ["-p", parent]);
  }
  writeFileSync(entryPath, src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  const manifest: Record<string, unknown> = {
    name, version, sdk, target: "js",
    entry: entryRel,
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    // NB: no `artifact` field — this is what `path A.3` must accept.
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  const tarball = join(dir, `${name}-${version}.tgz`);
  // Pack plugin.json + entry file at the staged paths.
  const entryRelInTar = entryRel.replace(/^\.\//, "");
  const tar = spawnSync("tar", [
    "-czf", tarball, "-C", dir, "plugin.json", entryRelInTar,
  ]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { dir, entryPath, sha256: sha, tarball, entryRel };
}

/** Build a BUILT-plugin tarball (legacy / backwards-compat shape). */
function buildBuiltFixture(opts: {
  name?: string; version?: string; sdk?: string;
  capabilities?: string[];
} = {}): { dir: string; bundle: string; sha256: string; tarball: string } {
  const name = opts.name ?? "built-hello";
  const version = opts.version ?? "0.1.0";
  const sdk = opts.sdk ?? "^1.0.0";
  const src = "export default () => ({ ok: true });\n";
  const dir = tmpDir("maw-built-fixture-");
  const bundle = join(dir, "index.js");
  writeFileSync(bundle, src);
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  const manifest: Record<string, unknown> = {
    name, version, sdk, target: "js",
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : { capabilities: [] }),
    artifact: { path: "./index.js", sha256: sha },
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  const tarball = join(dir, `${name}-${version}.tgz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json", "index.js"]);
  if (tar.status !== 0) throw new Error("tar failed");
  return { dir, bundle, sha256: sha, tarball };
}

// ─── A. source-plugin install (path A.3) ─────────────────────────────────────

describe("#874 path A.3 — source plugin install (no artifact, has entry)", () => {
  test("source-only manifest installs successfully", async () => {
    const fx = buildSourceFixture({ name: "src-only" });
    const { exitCode, stdout, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain("tarball manifest has no 'artifact' field");
    expect(existsSync(join(pluginsDir(), "src-only"))).toBe(true);
    expect(existsSync(join(pluginsDir(), "src-only", "index.ts"))).toBe(true);
    expect(stdout).toContain("src-only@0.1.0 installed");
  });

  test("source-only manifest with nested entry (./src/index.ts) installs", async () => {
    const fx = buildSourceFixture({
      name: "src-nested",
      entry: "./src/index.ts",
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain("tarball manifest has no 'artifact' field");
    expect(existsSync(join(pluginsDir(), "src-nested", "src", "index.ts"))).toBe(true);
  });

  test("source plugin records entry-file sha256 into plugins.lock", async () => {
    const fx = buildSourceFixture({ name: "src-lock" });
    const { exitCode } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    const lock = JSON.parse(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf8"));
    expect(lock.plugins["src-lock"]).toBeDefined();
    // Recorded hash matches the entry-file bytes (source IS the artifact).
    expect(lock.plugins["src-lock"].sha256).toBe(fx.sha256);
  });

  test("built-tarball install path still works (backwards compat)", async () => {
    const fx = buildBuiltFixture({ name: "still-built" });
    const { exitCode, stdout, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain("tarball manifest has no 'artifact' field");
    expect(existsSync(join(pluginsDir(), "still-built", "index.js"))).toBe(true);
    expect(stdout).toContain("still-built@0.1.0 installed");
    expect(stdout).toContain("installed (sha256:");
  });

  test("manifest with neither artifact nor entry → still rejected (no plugin to run)", async () => {
    // Build a tarball whose plugin.json has nothing executable.
    const dir = tmpDir("maw-naked-");
    const manifest = { name: "naked", version: "0.1.0", sdk: "^1.0.0" };
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    const tarball = join(dir, "naked-0.1.0.tgz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json"]);
    expect(tar.status).toBe(0);
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([tarball, "--pin"]),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no 'artifact' field");
  });

  test("source plugin with tampered entry (lock-mismatch) → refused on re-install", async () => {
    const fx = buildSourceFixture({ name: "src-tamper" });
    // First install: TOFU pins fx.sha256.
    await capture(() => cmdPluginInstall([fx.tarball, "--pin"]));

    // Build a tampered tarball with the same name+version but different
    // entry source. The pinned sha must catch it.
    const tampered = buildSourceFixture({
      name: "src-tamper",
      version: "0.1.0",
      source: "export default () => ({ tampered: true });\n",
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([tampered.tarball]),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("sha256 mismatch");
  });
});

// ─── B. capability namespaces (tmux + shell) ─────────────────────────────────

describe("#874 — tmux + shell capability namespaces", () => {
  test("'tmux' is a known namespace", () => {
    expect(KNOWN_CAPABILITY_NAMESPACES.has("tmux")).toBe(true);
  });

  test("'shell' is a known namespace", () => {
    expect(KNOWN_CAPABILITY_NAMESPACES.has("shell")).toBe(true);
  });

  test("source plugin declaring capabilities:['tmux'] installs without warning", async () => {
    const fx = buildSourceFixture({
      name: "src-tmux",
      capabilities: ["tmux"],
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain('unknown capability namespace "tmux"');
  });

  test("source plugin declaring capabilities:['shell'] installs without warning", async () => {
    const fx = buildSourceFixture({
      name: "src-shell",
      capabilities: ["shell"],
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain('unknown capability namespace "shell"');
  });

  test("plugin declaring capabilities:['bogus'] still warns (unknown namespace)", () => {
    const dir = tmpDir("maw-bogus-cap-");
    writeFileSync(join(dir, "index.ts"), "export default () => {};");
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: any[]) => warnings.push(a.map(String).join(" "));
    try {
      // parseManifest itself emits the warning; the install path inherits it.
      parseManifest(
        JSON.stringify({
          name: "bogus-plugin",
          version: "0.1.0",
          sdk: "^1.0.0",
          entry: "./index.ts",
          capabilities: ["bogus"],
        }),
        dir,
      );
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.join("\n")).toContain('unknown capability namespace "bogus"');
  });

  test("plugin declaring tmux+shell+sdk together installs cleanly", async () => {
    const fx = buildSourceFixture({
      name: "src-multi-cap",
      capabilities: ["tmux", "shell", "sdk:identity"],
    });
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([fx.tarball, "--pin"]),
    );
    expect(exitCode).toBeUndefined();
    expect(stderr).not.toContain('unknown capability namespace');
  });
});
