/**
 * E2E test for `maw plugin install <url>` — real HTTP via Bun.serve().
 *
 * The sibling plugin-install.test.ts covers URL installs with mocked fetch.
 * This file exercises the real fetch() path: downloadTarball -> fs write ->
 * installFromTarball. We spin up Bun.serve on a random port, serve a
 * pre-built .tgz, and route a few paths to failure modes (404, wrong
 * content-type, truncated bytes).
 *
 * Isolated (not in main bun test run) for the same reason as its sibling:
 * tests toggle process.exit + globals that shouldn't leak into the main suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cmdPluginInstall } from "../../src/commands/plugins/plugin/install-impl";
import { __resetDiscoverStateForTests } from "../../src/plugin/registry";

// ─── Fixture: a real built plugin tarball ────────────────────────────────────

let server: { stop: () => void; port: number } | null = null;
let tarballBytes: Uint8Array;
let truncatedBytes: Uint8Array;
let fixtureRoot: string;

const BUNDLE_SRC = 'export default () => ({ ok: true, output: "url-test" });\n';
const BUNDLE_SHA = "sha256:" + createHash("sha256").update(BUNDLE_SRC).digest("hex");

function buildTarballFixture(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "maw-url-fixture-"));
  fixtureRoot = dir;
  writeFileSync(join(dir, "index.js"), BUNDLE_SRC);
  const manifest = {
    name: "url-test-plugin",
    version: "0.1.0",
    sdk: "^1.0.0",
    target: "js",
    capabilities: [],
    artifact: { path: "./index.js", sha256: BUNDLE_SHA },
    cli: { command: "url-test-plugin" },
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  const tarballPath = join(dir, "url-test-plugin-0.1.0.tgz");
  const r = spawnSync("tar", ["-czf", tarballPath, "-C", dir, "plugin.json", "index.js"]);
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return readFileSync(tarballPath);
}

// ─── Per-test isolation (same pattern as plugin-install.test.ts) ─────────────

const created: string[] = [];
let origPluginsDir: string | undefined;

function tmpDir(prefix = "maw-url-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  process.env.MAW_PLUGINS_DIR = join(tmpDir("maw-home-"), "plugins");
  __resetDiscoverStateForTests();
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/** Intercept process.exit + console (borrowed from plugin-install.test.ts). */
async function capture(fn: () => Promise<unknown>): Promise<{
  exitCode: number | undefined; stdout: string; stderr: string;
}> {
  const o = { exit: process.exit, log: console.log, err: console.error, warn: console.warn };
  const outs: string[] = [], errs: string[] = [];
  let exitCode: number | undefined;
  console.log = (...a: any[]) => outs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => errs.push(a.map(String).join(" "));
  console.warn = (...a: any[]) => errs.push(a.map(String).join(" "));
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
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

beforeAll(() => {
  tarballBytes = buildTarballFixture();
  // Truncate midway through the gzip stream — tar will refuse, and even if
  // it somehow got past tar, the artifact hash would not match.
  truncatedBytes = tarballBytes.slice(0, Math.max(32, Math.floor(tarballBytes.length / 2)));

  const s = Bun.serve({
    port: 0, // random free port
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/plugin.tgz":
          return new Response(tarballBytes, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          });
        case "/truncated.tgz":
          return new Response(truncatedBytes, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          });
        case "/wrong-type.tgz":
          return new Response("<html><body>not a tarball</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  server = { stop: () => s.stop(true), port: s.port };
});

afterAll(() => {
  server?.stop();
  server = null;
  if (fixtureRoot && existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function urlFor(path: string): string {
  return `http://127.0.0.1:${server!.port}${path}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdPluginInstall — URL source (real Bun.serve)", () => {
  test("happy path: downloads, extracts, verifies hash, installs", async () => {
    const pluginsDir = process.env.MAW_PLUGINS_DIR!;
    const { exitCode, stdout } = await capture(() =>
      cmdPluginInstall([urlFor("/plugin.tgz")]));
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("url-test-plugin@0.1.0 installed");
    expect(stdout).toContain(`from ${urlFor("/plugin.tgz")}`);
    expect(stdout).toContain("installed (sha256:");
    expect(existsSync(join(pluginsDir, "url-test-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginsDir, "url-test-plugin", "index.js"))).toBe(true);
  });

  test("404 → exits 1 with HTTP error, nothing installed", async () => {
    const pluginsDir = process.env.MAW_PLUGINS_DIR!;
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([urlFor("/does-not-exist.tgz")]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("download failed");
    expect(stderr).toContain("404");
    expect(existsSync(join(pluginsDir, "url-test-plugin"))).toBe(false);
  });

  test("wrong content-type → exits 1 before writing to disk", async () => {
    const pluginsDir = process.env.MAW_PLUGINS_DIR!;
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([urlFor("/wrong-type.tgz")]));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("content-type");
    expect(stderr).toContain("gzip/tar");
    expect(existsSync(join(pluginsDir, "url-test-plugin"))).toBe(false);
  });

  test("truncated bytes → tar extract fails, nothing installed", async () => {
    // Truncated gzip bytes pass the content-type gate but tar -xzf will fail
    // (or the manifest won't parse). Either way: exit 1, no install.
    const pluginsDir = process.env.MAW_PLUGINS_DIR!;
    const { exitCode, stderr } = await capture(() =>
      cmdPluginInstall([urlFor("/truncated.tgz")]));
    expect(exitCode).toBe(1);
    // Error surface can be "tar extract failed" OR "no plugin.json" — both are
    // actionable. Just assert one of the two.
    const actionable = /tar list failed|tar extract failed|no plugin\.json|invalid plugin\.json/;
    expect(stderr).toMatch(actionable);
    expect(existsSync(join(pluginsDir, "url-test-plugin"))).toBe(false);
  });
});
