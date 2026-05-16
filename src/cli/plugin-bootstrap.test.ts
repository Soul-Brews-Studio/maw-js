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

  /** Helper: create a bundled plugin dir. Only manifest dirs are valid plugin packages. */
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

  /** Helper: create a vendored mpr plugin dir recognized by runBootstrap. */
  function makeVendoredPlugin(name: string) {
    const dir = join(vendoredDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
    writeFileSync(join(dir, "index.ts"), `export default async () => ({ ok: true });\n`);
    return dir;
  }

  /** Helper: create a previous maw-js package root with a bundled plugin. */
  function makeStaleMawJsBundledPlugin(name: string, lane: "commands" | "vendor" = "commands") {
    const root = join(workDir, `old-maw-js-${lane}-${name}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "maw-js", version: "0.0.0-old" }));
    const dir = lane === "commands"
      ? join(root, "src", "commands", "plugins", name)
      : join(root, "src", "vendor", "mpr-plugins", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
    writeFileSync(join(dir, "index.ts"), `export default async () => ({ stale: true });\n`);
    return dir;
  }

  /** Helper: create a legacy maw-plugin-registry checkout plugin. */
  function makeLegacyMawPluginRegistryPlugin(name: string) {
    const root = join(workDir, `maw-plugin-registry-${name}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "maw-plugin-registry", version: "0.0.0-old" }));
    const dir = join(root, "plugins", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, weight: 80 }));
    writeFileSync(join(dir, "index.ts"), `export default async () => ({ legacyMpr: true });\n`);
    return dir;
  }

  it("empty pluginDir → all bundled plugins symlinked (first install)", async () => {
    makeBundledPlugin("alpha");
    makeBundledPlugin("beta");
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

  it("#1339 — empty pluginDir also symlinks vendored maw-plugin-registry plugins", async () => {
    makeBundledPlugin("tile");
    makeVendoredPlugin("wake");
    makeVendoredPlugin("attach");

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["attach", "tile", "wake"]);
    expect(readlinkSync(join(pluginDir, "tile"))).toBe(join(bundledDir, "tile"));
    expect(readlinkSync(join(pluginDir, "wake"))).toBe(join(vendoredDir, "wake"));
    expect(readlinkSync(join(pluginDir, "attach"))).toBe(join(vendoredDir, "attach"));
  });

  it("#1484 — incomplete in-tree plugin dir does not block vendored manifest plugin", async () => {
    makeBundledPlugin("team", "index"); // legacy/incomplete in-tree team surface
    const vendoredTeam = makeVendoredPlugin("team");

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["team"]);
    expect(lstatSync(join(pluginDir, "team")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "team"))).toBe(vendoredTeam);
  });

  it("#1484 — existing symlink to non-manifest plugin dir is healed to vendored plugin", async () => {
    const incompleteTeam = makeBundledPlugin("team", "index");
    const vendoredTeam = makeVendoredPlugin("team");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(incompleteTeam, join(pluginDir, "team"));
    expect(lstatSync(join(pluginDir, "team")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pluginDir, "team"))).toBe(true);
    expect(readlinkSync(join(pluginDir, "team"))).toBe(incompleteTeam);

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(join(pluginDir, "team")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "team"))).toBe(vendoredTeam);
  });

  it("#1491 — stale symlink to an older maw-js bundled plugin is healed to current package", async () => {
    const currentFleet = makeBundledPlugin("fleet");
    const staleFleet = makeStaleMawJsBundledPlugin("fleet");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(staleFleet, join(pluginDir, "fleet"));
    expect(readlinkSync(join(pluginDir, "fleet"))).toBe(staleFleet);

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(join(pluginDir, "fleet")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "fleet"))).toBe(currentFleet);
  });

  it("#1491 — stale symlink to an older vendored maw-js plugin is healed to current vendor", async () => {
    const currentWake = makeVendoredPlugin("wake");
    const staleWake = makeStaleMawJsBundledPlugin("wake", "vendor");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(staleWake, join(pluginDir, "wake"));
    expect(readlinkSync(join(pluginDir, "wake"))).toBe(staleWake);

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(join(pluginDir, "wake")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "wake"))).toBe(currentWake);
  });

  it("#1507 — legacy maw-plugin-registry symlink is healed to current vendored plugin", async () => {
    const currentInbox = makeVendoredPlugin("inbox");
    const legacyInbox = makeLegacyMawPluginRegistryPlugin("inbox");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(legacyInbox, join(pluginDir, "inbox"));
    expect(readlinkSync(join(pluginDir, "inbox"))).toBe(legacyInbox);

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(join(pluginDir, "inbox")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "inbox"))).toBe(currentInbox);
  });

  it("#1491 — symlinked user plugin override is not treated as stale maw-js bundle", async () => {
    makeBundledPlugin("fleet");
    const userFleet = join(workDir, "user-plugins", "fleet");
    mkdirSync(userFleet, { recursive: true });
    writeFileSync(join(userFleet, "plugin.json"), JSON.stringify({ name: "fleet" }));
    writeFileSync(join(userFleet, "index.ts"), `export default async () => ({ user: true });\n`);

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(userFleet, join(pluginDir, "fleet"));

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(join(pluginDir, "fleet")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "fleet"))).toBe(userFleet);
  });

  it("#1339 — user plugin dirs override vendored plugin names", async () => {
    makeVendoredPlugin("wake");
    mkdirSync(pluginDir, { recursive: true });
    const userWake = join(pluginDir, "wake");
    mkdirSync(userWake, { recursive: true });
    writeFileSync(join(userWake, "plugin.json"), JSON.stringify({ name: "wake" }));

    await runBootstrap(pluginDir, srcDir);

    expect(lstatSync(userWake).isDirectory()).toBe(true);
    expect(lstatSync(userWake).isSymbolicLink()).toBe(false);
  });

  it("#1531 — valid in-tree plugin wins when a vendored plugin has the same name", async () => {
    const builtinSwarm = makeBundledPlugin("swarm");
    makeVendoredPlugin("swarm");

    await runBootstrap(pluginDir, srcDir);

    expect(readdirSync(pluginDir).sort()).toEqual(["swarm"]);
    expect(lstatSync(join(pluginDir, "swarm")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "swarm"))).toBe(builtinSwarm);
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

  it("non-plugin dirs (no plugin.json) are skipped even when they have index.ts", async () => {
    makeBundledPlugin("alpha");
    // garbage dir under bundled — not a plugin
    mkdirSync(join(bundledDir, "_shared"), { recursive: true });
    writeFileSync(join(bundledDir, "_shared", "util.ts"), "// helper\n");
    makeBundledPlugin("index-only", "index");

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
    makeVendoredPlugin("wake");

    mkdirSync(pluginDir, { recursive: true });
    symlinkSync("/nonexistent/old-maw-js/packages/wake", join(pluginDir, "wake"));
    expect(lstatSync(join(pluginDir, "wake")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pluginDir, "wake"))).toBe(false);

    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

    try {
      await runBootstrap(pluginDir, srcDir);

      expect(lstatSync(join(pluginDir, "wake")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(pluginDir, "wake"))).toBe(join(vendoredDir, "wake"));
      expect(warns.some(w => w.includes("broken plugin symlink"))).toBe(false);
    } finally {
      console.warn = originalWarn;
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
