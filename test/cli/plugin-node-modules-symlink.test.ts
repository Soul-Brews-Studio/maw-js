/**
 * test/cli/plugin-node-modules-symlink.test.ts — #1339 Option E
 * `ensureMawJsResolvable` from `src/plugin/ensure-maw-js-resolvable.ts`.
 *
 * Validates the helper that lays a single shared symlink
 *   <installRoot>/../node_modules/maw-js → <mawJsRoot>
 * so plugins under `<installRoot>/<name>/` can resolve `import "maw-js/..."`
 * via the standard node_modules walk-up. See the impl module header for
 * full Layer 2 / sila trace context.
 *
 * ## #1354 path change
 *
 * Original (#1339 Option E v1) placed the symlink INSIDE installRoot as a
 * sibling of plugin dirs — that caused bun cycles + auto-population. The
 * hot-fix (#1354) moved it ONE LEVEL UP: `installRoot()/../node_modules/`.
 * Tests below set up fixtures at the parent-level path.
 *
 * ## Mocking strategy (per #1335 retro)
 *
 * - NO `mock.module()` / NO `mock.module(process.stderr.write, ...)` — those
 *   are the test-pollution + Bun 1.3.13 epoll patterns the retro called out.
 * - Two env knobs the impl already exposes give us a clean test seam:
 *     1. `MAW_PLUGINS_DIR`  → overrides `installRoot()` (per-test tmpdir).
 *     2. `MAW_JS_PATH`      → overrides the maw-js source root the link
 *                              should point at (per-test tmpdir).
 * - Every test calls `mkdtempSync` for both knobs, then `rmSync` in afterEach.
 *   No global state leaks between tests.
 *
 * ## Placement
 *
 * test/cli/ subdir — sidesteps the test/*.test.ts shard re-partitioning bug
 * (#1335 retro) and matches the precedent set by plugin-install-tier.test.ts.
 *
 * ## Timeout
 *
 * 5000ms per test — avoids the #1348 shard-3 hang (default 30s lets a
 * deadlocked symlink call burn the whole shard before failing).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
import { join } from "path";
import { tmpdir } from "os";

import { ensureMawJsResolvable } from "../../src/plugin/ensure-maw-js-resolvable";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];

let origPluginsDir: string | undefined;
let origMawJsPath: string | undefined;

// #1308 — guard against a prior shard test leaving stderr.write monkey-patched
// against a disposed closure. (The impl never touches stderr but other test
// files in the shard do; we restore from a pristine pointer captured here.)
const pristineStderrWrite = process.stderr.write.bind(process.stderr);

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/**
 * Create a per-test sandbox so `join(installRoot(), "..", "node_modules")`
 * resolves to a unique path per test (not the shared OS tmpdir).
 * Layout: `<sandbox>/plugins/` = MAW_PLUGINS_DIR
 *         `<sandbox>/node_modules/` = where the impl writes the symlink
 */
function makeSandbox(): string {
  const sandbox = tmpDir("maw-sandbox-");
  const pluginsDir = join(sandbox, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  return pluginsDir;
}

function makeMawJsRoot(): string {
  const root = tmpDir("maw-js-root-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "maw-js", version: "0.0.0-test" }),
  );
  return root;
}

beforeEach(() => {
  if (typeof process.stderr.write !== "function") {
    (process.stderr as any).write = pristineStderrWrite;
  }
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origMawJsPath = process.env.MAW_JS_PATH;

  process.env.MAW_PLUGINS_DIR = makeSandbox();
  process.env.MAW_JS_PATH = makeMawJsRoot();
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  if (origMawJsPath !== undefined) process.env.MAW_JS_PATH = origMawJsPath;
  else delete process.env.MAW_JS_PATH;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── Cases ───────────────────────────────────────────────────────────────────

describe("ensureMawJsResolvable", () => {
  test(
    "creates node_modules dir + symlink when nothing exists",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const mawJsRoot = process.env.MAW_JS_PATH!;
      const nodeModulesDir = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModulesDir, "maw-js");

      expect(existsSync(nodeModulesDir)).toBe(false);
      expect(existsSync(linkPath)).toBe(false);

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(true);
      expect(r.linkPath).toBe(linkPath);
      expect(r.target).toBe(mawJsRoot);
      expect(existsSync(nodeModulesDir)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);
    },
    5000,
  );

  test(
    "no-op when correct symlink already exists",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const mawJsRoot = process.env.MAW_JS_PATH!;
      const nodeModules = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModules, "maw-js");

      mkdirSync(nodeModules, { recursive: true });
      symlinkSync(mawJsRoot, linkPath, "dir");

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(false);
      expect(r.reason).toMatch(/already correct/i);
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);
    },
    5000,
  );

  test(
    "safety: refuses to clobber live symlink pointing elsewhere",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const nodeModules = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModules, "maw-js");

      const wrongTarget = tmpDir("maw-js-wrong-");
      writeFileSync(
        join(wrongTarget, "package.json"),
        JSON.stringify({ name: "maw-js", version: "9.9.9-impostor" }),
      );

      mkdirSync(nodeModules, { recursive: true });
      symlinkSync(wrongTarget, linkPath, "dir");

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(false);
      expect(r.reason).toMatch(/manual fix|points to/i);
      expect(readlinkSync(linkPath)).toBe(wrongTarget);
    },
    5000,
  );

  test(
    "creates symlink when node_modules dir already exists but link is missing",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const mawJsRoot = process.env.MAW_JS_PATH!;
      const nodeModules = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModules, "maw-js");

      mkdirSync(nodeModules, { recursive: true });
      writeFileSync(join(nodeModules, ".keep"), "");
      expect(existsSync(linkPath)).toBe(false);

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);
      expect(existsSync(join(nodeModules, ".keep"))).toBe(true);
    },
    5000,
  );

  test(
    "replaces a dangling symlink (target deleted)",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const mawJsRoot = process.env.MAW_JS_PATH!;
      const nodeModules = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModules, "maw-js");

      const ghost = tmpDir("maw-js-ghost-");
      mkdirSync(nodeModules, { recursive: true });
      symlinkSync(ghost, linkPath, "dir");
      rmSync(ghost, { recursive: true, force: true });

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(existsSync(linkPath)).toBe(false);

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(true);
      expect(r.reason).toMatch(/dangling/i);
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);
    },
    5000,
  );

  test(
    "leaves a real (non-symlink) file at maw-js path alone",
    () => {
      const installRoot = process.env.MAW_PLUGINS_DIR!;
      const nodeModules = join(installRoot, "..", "node_modules");
      const linkPath = join(nodeModules, "maw-js");

      mkdirSync(linkPath, { recursive: true });
      writeFileSync(join(linkPath, "package.json"), "{}");

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(false);
      expect(r.reason).toMatch(/not a symlink/i);
      expect(lstatSync(linkPath).isDirectory()).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    },
    5000,
  );

  test(
    "graceful no-op when maw-js root does not exist",
    () => {
      // Point MAW_JS_PATH at a path we never created.
      const ghost = join(tmpdir(), "maw-js-never-existed-" + Date.now() + "-" + Math.random());
      process.env.MAW_JS_PATH = ghost;
      expect(existsSync(ghost)).toBe(false);

      const r = ensureMawJsResolvable();

      expect(r.changed).toBe(false);
      expect(r.reason).toMatch(/not found/i);
      const linkPath = join(process.env.MAW_PLUGINS_DIR!, "..", "node_modules", "maw-js");
      expect(existsSync(linkPath)).toBe(false);
    },
    5000,
  );

  test(
    "idempotent end-to-end: first call creates, second call is a no-op",
    () => {
      const mawJsRoot = process.env.MAW_JS_PATH!;
      const linkPath = join(process.env.MAW_PLUGINS_DIR!, "..", "node_modules", "maw-js");

      const first = ensureMawJsResolvable();
      expect(first.changed).toBe(true);
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);

      const second = ensureMawJsResolvable();
      expect(second.changed).toBe(false);
      expect(second.reason).toMatch(/already correct/i);
      // Link unchanged.
      expect(readlinkSync(linkPath)).toBe(mawJsRoot);
    },
    5000,
  );
});
