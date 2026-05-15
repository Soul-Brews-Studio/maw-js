import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
 * #1186 — `runBootstrap` now dynamic-imports `../config` so the multi-source
 * resolver can read `bundledPluginSource`. paths.ts caches CONFIG_FILE on
 * first load, so MAW_HOME must be sandboxed before any test calls
 * runBootstrap. MAW_TEST_MODE=1 makes `persistBundledPath` a no-op as a
 * second line of defence against corrupting the developer's real config.
 */
let configSandbox: string;
beforeAll(() => {
  configSandbox = mkdtempSync(join(tmpdir(), "maw-bootstrap-config-"));
  process.env.MAW_HOME = configSandbox;
  process.env.MAW_TEST_MODE = "1";
});
afterAll(() => {
  try { rmSync(configSandbox, { recursive: true, force: true }); } catch {}
  delete process.env.MAW_HOME;
  delete process.env.MAW_TEST_MODE;
});

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
  let vendoredDir: string;

  beforeEach(() => {
    // mkdtempSync is atomic — appends 6 random chars + creates the dir in one
    // syscall. Avoids js/insecure-temporary-file (CodeQL) which flags the
    // mkdirSync(join(tmpdir(), userControlledName)) pattern as race-prone.
    workDir = mkdtempSync(join(tmpdir(), "maw-bootstrap-test-"));
    srcDir = join(workDir, "src");
    pluginDir = join(workDir, "plugins");
    bundledDir = join(srcDir, "commands", "plugins");
    vendoredDir = join(srcDir, "vendor", "mpr-plugins");
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

  /** Helper: create a vendored plugin dir that runBootstrap can heal to. */
  function makeVendoredPlugin(name: string) {
    const dir = join(vendoredDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
    writeFileSync(join(dir, "index.ts"), `export default async () => ({ ok: true });\n`);
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

  it("#1015 — broken symlinks are pruned before linking", async () => {
    makeBundledPlugin("alpha");

    mkdirSync(pluginDir, { recursive: true });
    // Simulate a broken symlink: points to a target that doesn't exist
    symlinkSync("/nonexistent/old-maw-js/src/commands/plugins/workon", join(pluginDir, "workon"));
    symlinkSync("/nonexistent/old-maw-js/src/commands/plugins/wake", join(pluginDir, "wake"));
    // Verify they're broken
    expect(lstatSync(join(pluginDir, "workon")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pluginDir, "workon"))).toBe(false);

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

    try {
      await runBootstrap(pluginDir, srcDir);

      // Broken symlinks removed
      expect(existsSync(join(pluginDir, "workon"))).toBe(false);
      expect(existsSync(join(pluginDir, "wake"))).toBe(false);
      // But they shouldn't appear in readdirSync either
      const entries = readdirSync(pluginDir);
      expect(entries).not.toContain("workon");
      expect(entries).not.toContain("wake");
      // Bundled plugin still linked
      expect(entries).toContain("alpha");
      // Warning was logged
      expect(warns.some(w => w.includes("2 broken plugin symlink"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("#1449 — broken symlinks are silently healed when the plugin is now vendored", async () => {
    // Use a repo-local stable source path for the vendored replacement.
    // On Linux CI, `tmpdir()` is `/tmp`, and #1314 intentionally refuses to
    // heal plugin symlinks *to* transient/worktree paths. The user-facing
    // #1449 case is a real package checkout, not a temp worktree.
    const stableRoot = mkdtempSync(join(process.cwd(), ".tmp-maw-bootstrap-heal-"));
    const stableSrcDir = join(stableRoot, "src");
    const stableVendoredDir = join(stableSrcDir, "vendor", "mpr-plugins");
    const wakeDir = join(stableVendoredDir, "wake");
    mkdirSync(wakeDir, { recursive: true });
    writeFileSync(join(wakeDir, "plugin.json"), JSON.stringify({ name: "wake" }));
    writeFileSync(join(wakeDir, "index.ts"), `export default async () => ({ ok: true });\n`);

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync("/nonexistent/old-maw-js/packages/wake", join(pluginDir, "wake"));
    expect(lstatSync(join(pluginDir, "wake")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pluginDir, "wake"))).toBe(false);

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

    try {
      await runBootstrap(pluginDir, stableSrcDir);

      expect(lstatSync(join(pluginDir, "wake")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(pluginDir, "wake"))).toBe(join(stableVendoredDir, "wake"));
      expect(warns.some(w => w.includes("broken plugin symlink"))).toBe(false);
    } finally {
      console.warn = originalWarn;
      rmSync(stableRoot, { recursive: true, force: true });
    }
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

/**
 * Tests for #1186 — multi-source resolver.
 *
 * The bug: the compiled binary's `import.meta.dir` no longer resolves to the
 * source tree, so `<srcDir>/commands/plugins` doesn't exist and bundled
 * plugins never re-symlink after `~/.maw/plugins/` is wiped.
 *
 * The fix: `runBootstrap` checks $MAW_BUNDLED_PLUGINS env first, then
 * `config.bundledPluginSource`, then falls back to the srcDir hint.
 */
describe("runBootstrap — #1186 multi-source resolver", () => {
  let workDir: string;
  let srcDir: string;
  let altBundled: string;
  let pluginDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "maw-bootstrap-1186-"));
    srcDir = join(workDir, "src");
    altBundled = join(workDir, "alt-bundled-plugins");
    pluginDir = join(workDir, "plugins");
    mkdirSync(join(srcDir, "commands", "plugins"), { recursive: true });
    mkdirSync(altBundled, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    delete process.env.MAW_BUNDLED_PLUGINS;
  });

  /** Create a plugin directory under `parent` that runBootstrap will accept. */
  function makePlugin(parent: string, name: string): void {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
  }

  it("env MAW_BUNDLED_PLUGINS overrides srcDir hint (compiled-binary case)", async () => {
    // Bundled plugins exist at both paths — env override wins.
    makePlugin(join(srcDir, "commands", "plugins"), "src-only");
    makePlugin(altBundled, "alt-only");
    process.env.MAW_BUNDLED_PLUGINS = altBundled;

    await runBootstrap(pluginDir, srcDir);

    const linked = readdirSync(pluginDir).sort();
    expect(linked).toEqual(["alt-only"]);
    expect(readlinkSync(join(pluginDir, "alt-only"))).toBe(join(altBundled, "alt-only"));
  });

  it("env MAW_BUNDLED_PLUGINS expands leading ~/", async () => {
    // Stash a real bundled dir somewhere under HOME so the ~/ expansion has
    // a target — we use the sandbox's own .maw-bundled subdir.
    const homeRel = ".maw-bundled-test";
    const homeAbs = join(process.env.HOME ?? "", homeRel);
    mkdirSync(homeAbs, { recursive: true });
    try {
      makePlugin(homeAbs, "tilde-resolved");
      process.env.MAW_BUNDLED_PLUGINS = `~/${homeRel}`;

      await runBootstrap(pluginDir, srcDir);

      expect(readdirSync(pluginDir).sort()).toEqual(["tilde-resolved"]);
    } finally {
      try { rmSync(homeAbs, { recursive: true, force: true }); } catch {}
    }
  });

  it("missing MAW_BUNDLED_PLUGINS target → falls through to srcDir hint", async () => {
    makePlugin(join(srcDir, "commands", "plugins"), "from-src");
    process.env.MAW_BUNDLED_PLUGINS = "/nonexistent/path/that/does/not/exist";

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["from-src"]);
  });

  it("no env + no srcDir bundled + empty pluginDir → warns, doesn't throw", async () => {
    // Remove the bundled dir so the resolver returns null.
    rmSync(join(srcDir, "commands", "plugins"), { recursive: true });

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    const originalLog = console.log;
    console.log = () => {};

    try {
      await runBootstrap(pluginDir, srcDir);
      expect(warns.some(w => w.includes("bundled-plugin source not found"))).toBe(true);
      expect(warns.some(w => w.includes("#1186"))).toBe(true);
      expect(existsSync(pluginDir)).toBe(true);
      expect(readdirSync(pluginDir)).toEqual([]);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
});

/**
 * Tests for #1314 — transient-worktree-path poisoning.
 *
 * The bug: `bun link maw-js` from `/tmp/maw-js-<N>` worktrees (common in
 * /parallel-ship setups) made `persistBundledPath` write the transient path
 * to config and auto-heal migrate symlinks toward it. When the worktree was
 * later removed, the next CLI invocation pruned all 18 dangling symlinks but
 * couldn't resolve a stable bundled path — silently leaving the user with
 * "unknown command: <bundled-plugin>" and the `wasEmpty` gate suppressed any
 * diagnostic.
 *
 * Fix: refuse to persist or migrate-toward `/tmp/`-prefixed paths; drop the
 * `wasEmpty` gate when `bundled === null` AND `pruned > 0`.
 *
 * These tests run under MAW_TEST_MODE=1 (set in the file's beforeAll), so
 * persistBundledPath is a no-op. We test the OTHER guards directly here —
 * the persist-skip is tested by reasoning about the env-mode contract.
 */
describe("runBootstrap — #1314 transient-worktree poisoning", () => {
  let workDir: string;
  let pluginDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "maw-bootstrap-1314-"));
    pluginDir = join(workDir, "plugins");
    mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    delete process.env.MAW_BUNDLED_PLUGINS;
  });

  it("auto-heal does NOT migrate symlinks to a /tmp/ source", async () => {
    // The isTransientPath guard catches /tmp/ and /private/tmp/ specifically
    // (not the macOS process-tmpdir at /var/folders/). To exercise it we
    // create real /tmp/ paths and clean them up explicitly.
    const transientSrc = `/tmp/maw-1314-transient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const transientBundled = join(transientSrc, "commands", "plugins");
    mkdirSync(join(transientBundled, "alpha"), { recursive: true });
    writeFileSync(join(transientBundled, "alpha", "plugin.json"), JSON.stringify({ name: "alpha" }));

    // Pre-existing symlink at dest pointing to a stable location. Auto-heal
    // should refuse to move it toward the /tmp/ source.
    const stableBundled = join(workDir, "stable", "src", "commands", "plugins", "alpha");
    mkdirSync(stableBundled, { recursive: true });
    writeFileSync(join(stableBundled, "plugin.json"), JSON.stringify({ name: "alpha" }));
    symlinkSync(stableBundled, join(pluginDir, "alpha"));
    const beforeTarget = readlinkSync(join(pluginDir, "alpha"));

    process.env.MAW_BUNDLED_PLUGINS = transientBundled;
    try {
      await runBootstrap(pluginDir, "/nonexistent/src");
      // Symlink target unchanged — auto-heal refused the transient migration.
      expect(readlinkSync(join(pluginDir, "alpha"))).toBe(beforeTarget);
    } finally {
      try { rmSync(transientSrc, { recursive: true, force: true }); } catch {}
    }
  });

  it("resolveBundledPath skips /tmp/ paths in config (falls through to srcDir hint)", async () => {
    // Config is sandboxed via MAW_HOME (beforeAll). Plant a transient path
    // there, then verify runBootstrap falls through to the srcDir hint.
    const transientPath = join("/tmp", `maw-poisoned-${Date.now()}`);
    // Don't actually create the path — even if it existed, the guard would
    // skip it. This tests the "skip via /tmp prefix" branch specifically.
    const { saveConfig, resetConfig } = await import("../config");
    saveConfig({ bundledPluginSource: transientPath });
    resetConfig();

    // Set up a real srcDir bundled tree as the fallback target.
    const srcDir = join(workDir, "src");
    const bundledDir = join(srcDir, "commands", "plugins");
    mkdirSync(join(bundledDir, "beta"), { recursive: true });
    writeFileSync(join(bundledDir, "beta", "plugin.json"), JSON.stringify({ name: "beta" }));

    await runBootstrap(pluginDir, srcDir);

    // Despite config pointing at the transient path, the srcDir bundled was
    // used → beta got linked.
    expect(readdirSync(pluginDir).sort()).toEqual(["beta"]);
    expect(readlinkSync(join(pluginDir, "beta"))).toBe(join(bundledDir, "beta"));
  });

  it("warns loudly when pruned > 0 AND bundled cannot be resolved (drops wasEmpty gate)", async () => {
    // Simulate the exact failure mode: pluginDir has registry symlinks
    // (NOT empty) PLUS dangling bundled symlinks. After pruning, no bundled
    // source can be found. Pre-#1314 the warning was suppressed.
    symlinkSync(join(workDir, "definitely-not-here", "tmux"), join(pluginDir, "tmux"));
    symlinkSync(join(workDir, "definitely-not-here", "attach"), join(pluginDir, "attach"));
    // A "registry plugin" that survives prune — its target exists.
    const registryPlugin = join(workDir, "registry", "some-plugin");
    mkdirSync(registryPlugin, { recursive: true });
    symlinkSync(registryPlugin, join(pluginDir, "some-plugin"));

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

    try {
      // No srcDir bundled, no env, no usable config → resolveBundledPath returns null.
      await runBootstrap(pluginDir, "/nonexistent/src");

      // pluginDir was NOT empty (registry symlink survives), but pruning
      // happened AND bundled is null → warning must fire.
      expect(warns.some(w => w.includes("bundled-plugin source not found"))).toBe(true);
      expect(warns.some(w => w.includes("#1314"))).toBe(true);
      // Recovery hint with pruned-count.
      expect(warns.some(w => w.includes("broken plugin symlink") && w.includes("pruned"))).toBe(true);
      expect(warns.some(w => w.includes("bun link maw-js"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  // Note: persistBundledPath's /tmp/ guard is exercised indirectly. Under
  // MAW_TEST_MODE=1 (file-level beforeAll) it's a no-op, so a direct
  // "did config get written?" assertion isn't safe. The guard's effect is
  // proven by the resolveBundledPath skip test above (which exercises the
  // downstream "config has /tmp path → skip it" path) plus the auto-heal
  // refusal test (which exercises the migrate-to-/tmp refusal path). Tests
  // that flip MAW_TEST_MODE off would risk corrupting the developer's
  // real ~/.config/maw/maw.config.json (per the saveConfig #820 guard).
});
