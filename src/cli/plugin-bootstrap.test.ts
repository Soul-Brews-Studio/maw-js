import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runBootstrap } from "./plugin-bootstrap";

/**
 * Tests for #817 — bootstrap-on-empty.
 *
 * The bug: the entire bootstrap body (including bundled-plugin symlinks)
 * was gated on `pluginDir` being empty. New bundled plugins added in an
 * update were silently invisible on every existing host.
 *
 * The fix: bundled-plugin symlinks are idempotent (run every boot, skip
 * existing dests). The `pluginSources` URL-fetch path stays first-install
 * only.
 */
describe("runBootstrap — #817 idempotent bundled-plugin symlinks", () => {
  let workDir: string;
  let srcDir: string;
  let pluginDir: string;
  let bundledDir: string;

  beforeEach(() => {
    // mkdtempSync is atomic — appends 6 random chars + creates the dir in one
    // syscall. Avoids js/insecure-temporary-file (CodeQL) which flags the
    // mkdirSync(join(tmpdir(), userControlledName)) pattern as race-prone.
    workDir = mkdtempSync(join(tmpdir(), "maw-bootstrap-test-"));
    srcDir = join(workDir, "src");
    pluginDir = join(workDir, "plugins");
    bundledDir = join(srcDir, "commands", "plugins");
    mkdirSync(bundledDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  /** Helper: create a bundled plugin dir that runBootstrap will recognize. */
  function makeBundledPlugin(name: string, kind: "manifest" | "index" = "manifest") {
    const dir = join(bundledDir, name);
    mkdirSync(dir, { recursive: true });
    if (kind === "manifest") {
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
    } else {
      writeFileSync(join(dir, "index.ts"), `export default async () => ({ ok: true });\n`);
    }
    return dir;
  }

  it("empty pluginDir → all bundled plugins symlinked (first install)", async () => {
    makeBundledPlugin("alpha");
    makeBundledPlugin("beta", "index");
    makeBundledPlugin("gamma");

    await runBootstrap(pluginDir, srcDir);

    const linked = readdirSync(pluginDir).sort();
    expect(linked).toEqual(["alpha", "beta", "gamma"]);
    for (const name of linked) {
      const dest = join(pluginDir, name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(bundledDir, name));
    }
  });

  it("non-empty pluginDir with N-1 of N plugins → 1 new symlink, others untouched", async () => {
    makeBundledPlugin("alpha");
    makeBundledPlugin("beta");
    makeBundledPlugin("shellenv"); // the new plugin from #816

    // Pre-existing install: alpha + beta symlinked, shellenv missing.
    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(join(bundledDir, "alpha"), join(pluginDir, "alpha"));
    symlinkSync(join(bundledDir, "beta"), join(pluginDir, "beta"));

    // Capture inode/mtime for the existing alpha symlink so we can verify
    // it wasn't recreated.
    const alphaBefore = lstatSync(join(pluginDir, "alpha")).ino;

    await runBootstrap(pluginDir, srcDir);

    const linked = readdirSync(pluginDir).sort();
    expect(linked).toEqual(["alpha", "beta", "shellenv"]);
    expect(lstatSync(join(pluginDir, "shellenv")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "shellenv"))).toBe(join(bundledDir, "shellenv"));

    // Pre-existing symlink not recreated (same inode).
    expect(lstatSync(join(pluginDir, "alpha")).ino).toBe(alphaBefore);
  });

  it("all N plugins already present → no-op (no new symlinks)", async () => {
    makeBundledPlugin("alpha");
    makeBundledPlugin("beta");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(join(bundledDir, "alpha"), join(pluginDir, "alpha"));
    symlinkSync(join(bundledDir, "beta"), join(pluginDir, "beta"));

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["alpha", "beta"]);
  });

  it("existing dest dir (user-owned, not a symlink) → skipped, not overwritten", async () => {
    makeBundledPlugin("alpha");

    mkdirSync(pluginDir, { recursive: true });
    // User has a real dir at the bundled-plugin name (e.g. fork, override).
    const userDir = join(pluginDir, "alpha");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "marker.txt"), "user-owned");

    await runBootstrap(pluginDir, srcDir);

    // Still a directory, not a symlink — bootstrap left it alone.
    expect(lstatSync(userDir).isDirectory()).toBe(true);
    expect(lstatSync(userDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(userDir, "marker.txt"))).toBe(true);
  });

  it("non-plugin dirs (no plugin.json, no index.ts) are skipped", async () => {
    makeBundledPlugin("alpha");
    // garbage dir under bundled — not a plugin
    mkdirSync(join(bundledDir, "_shared"), { recursive: true });
    writeFileSync(join(bundledDir, "_shared", "util.ts"), "// helper\n");

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["alpha"]);
  });

  it("missing bundled dir entirely → no error, pluginDir created", async () => {
    rmSync(bundledDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });

    await runBootstrap(pluginDir, srcDir);

    expect(existsSync(pluginDir)).toBe(true);
    expect(readdirSync(pluginDir)).toEqual([]);
  });

  it("pluginSources URL-fetch path is gated behind wasEmpty (only logs on first install)", async () => {
    // The `[maw] bootstrapped N plugins` console.log is inside the `wasEmpty`
    // branch alongside the URL-fetch logic — its presence/absence is a
    // proxy for whether the URL-fetch path executed.
    makeBundledPlugin("alpha");

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      // First install: pluginDir empty → wasEmpty branch should run.
      await runBootstrap(pluginDir, srcDir);
      const firstRunLogs = logs.filter((l) => l.includes("bootstrapped"));
      expect(firstRunLogs.length).toBe(1);

      // Second invocation with new bundled plugin added: pluginDir is NOT
      // empty → URL-fetch path must NOT re-run, but new symlink IS added.
      makeBundledPlugin("shellenv");
      logs.length = 0;
      await runBootstrap(pluginDir, srcDir);

      // No "bootstrapped" log → wasEmpty branch was correctly skipped.
      expect(logs.filter((l) => l.includes("bootstrapped")).length).toBe(0);
      // But the new bundled plugin WAS linked (the bug fix).
      expect(existsSync(join(pluginDir, "shellenv"))).toBe(true);
      expect(lstatSync(join(pluginDir, "shellenv")).isSymbolicLink()).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });
});
