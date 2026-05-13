/**
 * maw plugin sync (#1277) — reconcile broken symlinks from plugins.lock.
 *
 * Coverage:
 *   • All-ok lock → no changes, all entries reported as "ok".
 *   • Linked plugin with valid target + missing symlink → recreates link.
 *   • Linked plugin with target gone (source dir deleted) → reports broken.
 *   • Registry / tarball plugin with broken symlink → suggests reinstall.
 *   • --dry-run shows would-fix without touching filesystem.
 *   • Linked plugin with dangling symlink → does NOT delete (non-destructive).
 *   • Empty lock → no-op + clear message.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeLock, LOCK_SCHEMA, type Lock } from "../../src/commands/plugins/plugin/lock";
import { cmdPluginSync } from "../../src/commands/plugins/plugin/sync-impl";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;

function tmpDir(prefix = "maw-sync-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  const home = tmpDir("maw-home-");
  mkdirSync(home, { recursive: true });
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  mkdirSync(process.env.MAW_PLUGINS_DIR!, { recursive: true });
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

/** Capture console output from one sync run. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const result = await fn();
    return { result, stdout: lines.join("\n") };
  } finally {
    console.log = origLog;
  }
}

function makeLockEntry(opts: { source: string; version?: string }): Lock["plugins"][string] {
  return {
    version: opts.version ?? "0.1.0",
    sha256: "sha256:" + "a".repeat(64),
    source: opts.source,
    added: new Date().toISOString(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdPluginSync", () => {
  test("empty lock → 0/0/0/0 + friendly message", async () => {
    writeLock({ schema: LOCK_SCHEMA, updated: new Date().toISOString(), plugins: {} });
    const { result, stdout } = await capture(() => cmdPluginSync());
    expect(result).toEqual({ ok: 0, fixed: 0, broken: 0, missing: 0 });
    expect(stdout).toContain("plugins.lock is empty");
  });

  test("all symlinks ok → reports ok, no repair", async () => {
    const target = tmpDir("maw-plugin-src-");
    mkdirSync(join(target, "hello"), { recursive: true });
    const linkSource = join(target, "hello");
    symlinkSync(linkSource, join(pluginsDir(), "hello"));

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: { hello: makeLockEntry({ source: `link:${linkSource}` }) },
    });

    const { result } = await capture(() => cmdPluginSync());
    expect(result.ok).toBe(1);
    expect(result.fixed).toBe(0);
    expect(result.broken).toBe(0);
    expect(result.missing).toBe(0);
  });

  test("linked plugin missing symlink + valid target → recreates symlink", async () => {
    const target = tmpDir("maw-plugin-src-");
    const linkSource = join(target, "hello");
    mkdirSync(linkSource, { recursive: true });
    // No symlink in plugins dir — represents post-auto-cleanup state.

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: { hello: makeLockEntry({ source: `link:${linkSource}` }) },
    });

    const { result, stdout } = await capture(() => cmdPluginSync());
    expect(result.fixed).toBe(1);
    expect(result.ok).toBe(0);
    expect(result.broken).toBe(0);
    expect(stdout).toContain("fixed");

    // Symlink now exists and points where the lock said.
    const linkPath = join(pluginsDir(), "hello");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(linkPath)).toBe(true);
  });

  test("linked plugin with target missing → reports broken (not fixed)", async () => {
    const ghostTarget = "/nonexistent/abs/path/maw-plugin-ghost";

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: { ghost: makeLockEntry({ source: `link:${ghostTarget}` }) },
    });

    const { result, stdout } = await capture(() => cmdPluginSync());
    expect(result.broken).toBe(1);
    expect(result.fixed).toBe(0);
    expect(stdout).toContain("ghost");
    expect(stdout).toContain("link target missing");
    // No phantom symlink created.
    expect(existsSync(join(pluginsDir(), "ghost"))).toBe(false);
  });

  test("registry/tarball plugin broken → suggests reinstall (does not auto-fetch)", async () => {
    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: {
        registry_pkg: makeLockEntry({ source: "https://registry.maw.dev/foo-0.1.0.tgz" }),
      },
    });

    const { result, stdout } = await capture(() => cmdPluginSync());
    expect(result.missing).toBe(1);
    expect(result.fixed).toBe(0);
    expect(stdout).toContain("maw plugin install registry_pkg");
    expect(stdout).toContain("install --all");
  });

  test("--dry-run reports would-fix without touching the filesystem", async () => {
    const target = tmpDir("maw-plugin-src-");
    const linkSource = join(target, "hello");
    mkdirSync(linkSource, { recursive: true });

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: { hello: makeLockEntry({ source: `link:${linkSource}` }) },
    });

    const { result, stdout } = await capture(() => cmdPluginSync({ dryRun: true }));
    expect(result.fixed).toBe(1);
    expect(stdout).toContain("would fix");
    // Critically: dry-run did NOT create the symlink.
    expect(existsSync(join(pluginsDir(), "hello"))).toBe(false);
  });

  test("dangling symlink (link present, target reachable) → does NOT delete (non-destructive)", async () => {
    // First create a linked plugin pointing somewhere, then yank the
    // somewhere — leaves a dangling symlink. Sync should report it
    // without unlinking — the "Nothing is Deleted" principle.
    const target1 = tmpDir("maw-plugin-src-old-");
    const linkSourceOld = join(target1, "hello");
    mkdirSync(linkSourceOld, { recursive: true });
    symlinkSync(linkSourceOld, join(pluginsDir(), "hello"));

    // Now delete the original target → symlink dangles.
    rmSync(target1, { recursive: true, force: true });

    // Lock points at a NEW (still-valid) target.
    const target2 = tmpDir("maw-plugin-src-new-");
    const linkSourceNew = join(target2, "hello");
    mkdirSync(linkSourceNew, { recursive: true });

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: { hello: makeLockEntry({ source: `link:${linkSourceNew}` }) },
    });

    const { result, stdout } = await capture(() => cmdPluginSync());
    // Non-destructive: we don't unlink the dangling symlink. Report broken
    // and ask the user to refresh explicitly.
    expect(result.broken).toBe(1);
    expect(result.fixed).toBe(0);
    expect(stdout).toContain("dangling");
    // The dangling symlink is still there (we did not delete it).
    expect(lstatSync(join(pluginsDir(), "hello")).isSymbolicLink()).toBe(true);
  });

  test("mixed lock (ok + broken-link + tarball) → correct counts", async () => {
    // OK entry
    const okTarget = tmpDir("maw-plugin-src-ok-");
    const okSource = join(okTarget, "alpha");
    mkdirSync(okSource, { recursive: true });
    symlinkSync(okSource, join(pluginsDir(), "alpha"));

    // Fixable entry
    const fixTarget = tmpDir("maw-plugin-src-fix-");
    const fixSource = join(fixTarget, "beta");
    mkdirSync(fixSource, { recursive: true });

    writeLock({
      schema: LOCK_SCHEMA, updated: new Date().toISOString(),
      plugins: {
        alpha: makeLockEntry({ source: `link:${okSource}` }),
        beta: makeLockEntry({ source: `link:${fixSource}` }),
        gamma: makeLockEntry({ source: "https://example.com/gamma-0.1.0.tgz" }),
        delta: makeLockEntry({ source: "link:/no/such/path" }),
      },
    });

    const { result } = await capture(() => cmdPluginSync());
    expect(result.ok).toBe(1);       // alpha
    expect(result.fixed).toBe(1);    // beta
    expect(result.missing).toBe(1);  // gamma (registry)
    expect(result.broken).toBe(1);   // delta (target missing)
  });
});
