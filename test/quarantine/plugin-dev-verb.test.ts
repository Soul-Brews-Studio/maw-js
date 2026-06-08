/**
 * maw plugin dev — Phase B6 Wave 1B
 *
 * Verifies that `cmdPluginDev` / `cmdPluginBuild --watch`:
 *   1. Start with an initial build (dist/index.js + dist/plugin.json written).
 *   2. Log the "maw plugin dev" header (dev verb) or "watching" (build --watch).
 *   3. Register an fs.watch watcher on <dir>/src.
 *   4. `build --watch` alias still works (backward-compat invariant).
 *
 * Isolated because we mock.module `fs` to replace `watch` with a spy that
 * captures calls without blocking, and replace the keep-alive Promise with one
 * that resolves immediately so the test can finish.
 *
 * Per-file subprocess isolation per #429 pattern: mock.module is
 * process-global; capture real refs BEFORE installing any mocks.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Capture real `fs` refs before any mock.module installs ─────────────────
const realFs = await import("fs");
const realWatch = realFs.watch;

// ─── Spy state (reset per-test) ──────────────────────────────────────────────
let watchSpy: { path: string; opts: unknown }[] = [];
let keepAliveResolve: (() => void) | null = null;

// ─── Install fs mock (watch spy + pass-through for everything else) ──────────
await mock.module("fs", () => {
  return {
    ...realFs,
    watch: (path: string, opts: unknown, _cb: unknown) => {
      watchSpy.push({ path, opts });
      // Return a minimal fake FSWatcher that does nothing.
      return { close: () => {}, ref: () => {}, unref: () => {} };
    },
  };
});

// ─── Patch global Promise to break keep-alive on next tick ───────────────────
// We replace the keep-alive `new Promise(() => {})` inside runWatch by
// intercepting it at the module level via a re-export hook.  Simpler approach:
// import the function fresh each test so the mock.module replacement above has
// already taken effect, then race the call with a short-circuit.

// ─── Harness ─────────────────────────────────────────────────────────────────
const created: string[] = [];

function tmpDir(prefix = "maw-dev-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Scaffold a minimal buildable plugin directory. */
function scaffoldPlugin(dir: string, name = "hello-dev"): void {
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      entry: "./src/index.ts",
      sdk: "^1.0.0",
      capabilities: [],
    }, null, 2),
  );
  writeFileSync(join(srcDir, "index.ts"), "export default () => ({ ok: true });\n");
}

/** Capture console output while running fn, with a timeout escape hatch.
 *  The escape hatch resolves after `ms` ms so watch-mode never-resolve
 *  functions can still be observed. */
async function captureWithTimeout(
  fn: () => Promise<void>,
  ms = 3000,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const origLog = console.log;
  const origErr = console.error;
  const outs: string[] = [];
  const errs: string[] = [];
  console.log = (...a: unknown[]) => outs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  let timedOut = false;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, ms)),
    ]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout: outs.join("\n"), stderr: errs.join("\n"), timedOut };
}

beforeEach(() => {
  watchSpy = [];
});

afterEach(() => {
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("maw plugin dev verb", () => {
  test("cmdPluginDev: enters watch mode and registers fs.watch on src/", async () => {
    const dir = tmpDir();
    scaffoldPlugin(dir);

    const { cmdPluginDev } = await import("../../src/commands/plugins/plugin/build-impl");
    const { stdout, timedOut } = await captureWithTimeout(() => cmdPluginDev([dir]), 3000);

    // Should have timed out (watch mode never resolves)
    expect(timedOut).toBe(true);

    // Initial build should have produced dist/index.js
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);

    // dev verb header logged
    expect(stdout).toContain("maw plugin dev");

    // watching... message logged
    expect(stdout).toContain("watching");

    // fs.watch registered on <dir>/src
    expect(watchSpy.length).toBeGreaterThanOrEqual(1);
    expect(watchSpy[0].path).toBe(join(dir, "src"));
  });

  test("cmdPluginDev: initial build populates dist/plugin.json with artifact field", async () => {
    const dir = tmpDir();
    scaffoldPlugin(dir, "hello-artifact");

    const { cmdPluginDev } = await import("../../src/commands/plugins/plugin/build-impl");
    await captureWithTimeout(() => cmdPluginDev([dir]), 3000);

    const manifestPath = join(dir, "dist", "plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.artifact).toBeDefined();
    expect(manifest.artifact.sha256).toMatch(/^sha256:/);
  });

  test("cmdPluginBuild --watch: backward-compat alias still enters watch mode", async () => {
    const dir = tmpDir();
    scaffoldPlugin(dir, "hello-watch-flag");

    const { cmdPluginBuild } = await import("../../src/commands/plugins/plugin/build-impl");
    const { stdout, timedOut } = await captureWithTimeout(() => cmdPluginBuild([dir, "--watch"]), 3000);

    expect(timedOut).toBe(true);
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);

    // --watch should still log the "watching" message
    expect(stdout).toContain("watching");

    // fs.watch registered on <dir>/src
    expect(watchSpy.some((w) => w.path === join(dir, "src"))).toBe(true);
  });

  test("cmdPluginBuild --watch: does NOT log the dev verb header", async () => {
    const dir = tmpDir();
    scaffoldPlugin(dir, "hello-no-dev-header");

    const { cmdPluginBuild } = await import("../../src/commands/plugins/plugin/build-impl");
    const { stdout } = await captureWithTimeout(() => cmdPluginBuild([dir, "--watch"]), 3000);

    // The "maw plugin dev" header is only printed by cmdPluginDev, not --watch
    expect(stdout).not.toContain("maw plugin dev");
  });

  test("help text lists dev alongside build", async () => {
    const handler = (await import("../../src/commands/plugins/plugin/index")).default;
    const result = await handler({
      source: "cli",
      args: ["--help"],
      writer: undefined,
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("dev");
    expect(result.output).toContain("build");
  });

  test("plugin index routes dev subcommand without error", async () => {
    const dir = tmpDir();
    scaffoldPlugin(dir, "hello-route");

    const handler = (await import("../../src/commands/plugins/plugin/index")).default;
    // Race: invoke dev via the index handler, escape after initial build completes
    const resultP = handler({
      source: "cli",
      args: ["dev", dir],
      writer: undefined,
    } as any);

    // Let initial build run then check via timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    // Built artifact should exist regardless of whether resultP resolved
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
  });
});
