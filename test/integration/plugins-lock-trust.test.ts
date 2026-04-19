/**
 * plugins.lock trust flow — e2e proof for #680.
 *
 * Asserts the four behaviours the "lock-file is truth" model requires:
 *
 *   1. `maw init` on a clean HOME bootstraps an empty plugins.lock.
 *   2. `maw plugin install <tarball>` persists a sha256 entry to the lock.
 *   3. A second install of DIFFERENT bytes under the same name is REFUSED.
 *   4. --force overrides that refusal and updates the lock.
 *   5. `maw plugin install <dir> --link` records a `linked: true` +
 *      `source: "link:<dir>"` entry instead of a sha.
 *   6. `maw plugin pin` / `unpin` CLI round-trip updates the lock.
 *
 * Hermetic: MAW_HOME, MAW_PLUGINS_DIR, MAW_PLUGINS_LOCK redirect every side
 * effect to a per-suite tmpdir. No real HOME is touched.
 *
 * Written against the merged shape of three sibling branches (#680):
 *   • lock-writer     — adds auto-pin + --link lock entry
 *   • lock-verifier   — adds --force override on sha-mismatch refusal
 *   • init-bootstrap  — has `maw init` seed plugins.lock with schema 1
 *
 * If assertions fail against one branch alone, that's expected — the lead
 * runs this against all three merged together.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { join } from "path";

import {
  installFromDir,
  installFromTarball,
} from "../../src/commands/plugins/plugin/install-handlers";
import {
  cmdPluginPin,
  cmdPluginUnpin,
} from "../../src/commands/plugins/plugin/lock-cli";
import { runtimeSdkVersion } from "../../src/plugin/registry";

const SKIP = process.env.MAW_SKIP_INTEGRATION === "1";

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/**
 * Build a tiny but complete plugin source dir (plugin.json + dist/index.js)
 * and pack it into a .tgz. `marker` lets the test generate two tarballs with
 * the SAME name/version but DIFFERENT bytes (different sha256).
 */
function buildFakePlugin(
  srcDir: string,
  tarballPath: string,
  name: string,
  version: string,
  marker: string,
): { sha256: string } {
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(srcDir, "dist"), { recursive: true });
  const artifactRel = "dist/index.js";
  const artifactAbs = join(srcDir, artifactRel);
  writeFileSync(
    artifactAbs,
    `// #680 fake plugin — marker=${marker}\n` +
      `export default { name: ${JSON.stringify(name)}, marker: ${JSON.stringify(marker)} };\n`,
  );
  const sha256 = sha256File(artifactAbs);
  const manifest = {
    name,
    version,
    sdk: runtimeSdkVersion(),
    description: `Integration-test plugin for #680 (marker=${marker})`,
    artifact: { path: artifactRel, sha256 },
  };
  writeFileSync(join(srcDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  const tar = spawnSync("tar", ["-czf", tarballPath, "-C", srcDir, "."], {
    encoding: "utf8",
  });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { sha256 };
}

function readLockFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe.skipIf(SKIP)("plugins.lock trust flow (#680)", () => {
  let suiteRoot: string;
  const prev = {
    home: process.env.MAW_HOME,
    pluginsDir: process.env.MAW_PLUGINS_DIR,
    lock: process.env.MAW_PLUGINS_LOCK,
  };

  // Per-test working dirs — recreated in beforeEach so every case starts clean.
  let caseDir: string;
  let pluginsDir: string;
  let lockFile: string;

  beforeAll(() => {
    // MAW_HOME must be set BEFORE the init module is imported; CONFIG_FILE in
    // core/paths is resolved at module-load time from MAW_HOME. Lock/plugins
    // paths are read at call time, so those can be rewritten per test.
    suiteRoot = mkdtempSync(join(tmpdir(), "maw-lock-trust-"));
    process.env.MAW_HOME = join(suiteRoot, "maw-home");
    mkdirSync(process.env.MAW_HOME, { recursive: true });
  });

  afterAll(() => {
    rmSync(suiteRoot, { recursive: true, force: true });
    for (const [k, v] of [
      ["MAW_HOME", prev.home],
      ["MAW_PLUGINS_DIR", prev.pluginsDir],
      ["MAW_PLUGINS_LOCK", prev.lock],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    caseDir = mkdtempSync(join(suiteRoot, "case-"));
    pluginsDir = join(caseDir, "plugins");
    lockFile = join(caseDir, "plugins.lock");
    mkdirSync(pluginsDir, { recursive: true });
    process.env.MAW_PLUGINS_DIR = pluginsDir;
    process.env.MAW_PLUGINS_LOCK = lockFile;
  });

  it("1. `maw init` on clean HOME creates plugins.lock with empty schema", async () => {
    expect(existsSync(lockFile)).toBe(false);

    // init-bootstrap wires plugins.lock creation into cmdInit. Dynamic import
    // so we pick up the merged branch even though the top-level imports don't
    // touch core/paths.
    const { cmdInit } = await import("../../src/commands/plugins/init/impl");
    const result = await cmdInit({
      args: ["--non-interactive", "--node", "lock-trust-node", "--force"],
      writer: () => {},
    });
    expect(result.ok).toBe(true);

    expect(existsSync(lockFile)).toBe(true);
    const lock = readLockFile(lockFile);

    // Canonical field is `schema` (confirmed by init-bootstrap + lock-writer);
    // the issue body's "schemaVersion" was inexact.
    expect(lock.schema).toBe(1);
    expect(lock.plugins).toEqual({});
    expect(typeof lock.updated).toBe("string");
  });

  it("2. `maw plugin install <tarball>` writes a sha entry", async () => {
    const name = "lock-trust-install";
    const srcDir = join(caseDir, "src-install");
    const tarball = join(caseDir, "lock-trust-install.tgz");
    const { sha256 } = buildFakePlugin(srcDir, tarball, name, "1.0.0", "first");

    // lock-writer TOFU: first install of an unpinned name auto-adds the
    // entry — no --pin flag required. Also proves `added` is set.
    expect(existsSync(lockFile)).toBe(false);
    await installFromTarball(tarball, { source: tarball });

    expect(existsSync(lockFile)).toBe(true);
    const lock = readLockFile(lockFile);
    expect(lock.plugins[name]).toBeDefined();
    expect(lock.plugins[name].sha256).toBe(sha256);
    expect(lock.plugins[name].version).toBe("1.0.0");
    expect(lock.plugins[name].source).toBe(tarball);
    expect(typeof lock.plugins[name].added).toBe("string");
  });

  it("3. second install of a DIFFERENT tarball under the same name is refused", async () => {
    const name = "lock-trust-mismatch";
    const tarA = join(caseDir, "a.tgz");
    const tarB = join(caseDir, "b.tgz");
    const { sha256: shaA } = buildFakePlugin(
      join(caseDir, "src-a"), tarA, name, "1.0.0", "alpha",
    );
    const { sha256: shaB } = buildFakePlugin(
      join(caseDir, "src-b"), tarB, name, "1.0.0", "bravo",
    );
    expect(shaA).not.toBe(shaB); // sanity — our fake plugins really differ.

    // First install TOFU-pins shaA.
    await installFromTarball(tarA, { source: tarA });
    const lockAfterA = readLockFile(lockFile);
    expect(lockAfterA.plugins[name].sha256).toBe(shaA);

    // Second install of DIFFERENT bytes under SAME name → REFUSED.
    // lock-verifier's exact wording is
    // `plugin 'NAME' sha256 mismatch — refusing to install.`
    await expect(
      installFromTarball(tarB, { source: tarB, force: false }),
    ).rejects.toThrow(/sha256 mismatch/);

    // Lock must be unchanged — a refused install cannot mutate truth.
    const lockAfterRefusal = readLockFile(lockFile);
    expect(lockAfterRefusal.plugins[name].sha256).toBe(shaA);
  });

  it("4. --force overrides the refusal and updates the lock", async () => {
    const name = "lock-trust-force";
    const tarA = join(caseDir, "a.tgz");
    const tarB = join(caseDir, "b.tgz");
    const { sha256: shaA } = buildFakePlugin(
      join(caseDir, "src-a"), tarA, name, "1.0.0", "alpha",
    );
    const { sha256: shaB } = buildFakePlugin(
      join(caseDir, "src-b"), tarB, name, "1.0.0", "bravo",
    );

    await installFromTarball(tarA, { source: tarA });
    const addedOriginal = readLockFile(lockFile).plugins[name].added;

    // lock-verifier: --force bypasses the sha-mismatch refusal AND silently
    // re-pins the lock entry to the new sha. Before the verifier branch,
    // --force only affects the overwrite-refusal path in install-handlers,
    // not the lock-mismatch path.
    await installFromTarball(tarB, { source: tarB, force: true });

    const lock = readLockFile(lockFile);
    expect(lock.plugins[name].sha256).toBe(shaB);
    expect(lock.plugins[name].sha256).not.toBe(shaA);
    // `added` is preserved across re-pin per lock-writer's idempotency rule.
    expect(lock.plugins[name].added).toBe(addedOriginal);
  });

  it("5. --link install records linked:true + source:\"link:<dir>\"", async () => {
    const name = "lock-trust-linked";
    const srcDir = join(caseDir, "src-linked");
    // Build + write manifest but DON'T pack — --link installs from the dir.
    buildFakePlugin(srcDir, join(caseDir, "unused.tgz"), name, "1.0.0", "linked");

    // installFromDir is the --link handler. lock-writer's branch makes it
    // record a synthetic entry so `plugins.lock` reflects every live plugin,
    // including dev-linked ones (per issue #680 ask #1).
    await installFromDir(srcDir, {});

    expect(existsSync(lockFile)).toBe(true);
    const lock = readLockFile(lockFile);
    const entry = lock.plugins[name];
    expect(entry).toBeDefined();
    expect(entry.linked).toBe(true);
    // lock-writer: `source` = `"link:<absolute-path>"`; `sha256` = hash of
    // plugin.json bytes (present even though the dir is dev-mutable).
    expect(entry.source).toBe(`link:${srcDir}`);
    expect(entry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.version).toBe("1.0.0");
  });

  it("6. pin / unpin CLI round-trip updates the lock", async () => {
    const name = "lock-trust-pin";
    const tarball = join(caseDir, "pin.tgz");
    const { sha256 } = buildFakePlugin(
      join(caseDir, "src-pin"), tarball, name, "1.0.0", "pin",
    );

    await cmdPluginPin([name, tarball]);
    const afterPin = readLockFile(lockFile);
    expect(afterPin.plugins[name]).toBeDefined();
    expect(afterPin.plugins[name].sha256).toBe(sha256);
    expect(afterPin.plugins[name].version).toBe("1.0.0");

    await cmdPluginUnpin([name]);
    const afterUnpin = readLockFile(lockFile);
    expect(afterUnpin.plugins[name]).toBeUndefined();
  });
});
