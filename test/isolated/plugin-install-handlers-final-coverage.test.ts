/** Final focused coverage for src/commands/plugins/plugin/install-handlers.ts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { LOCK_SCHEMA } from "../../src/commands/plugins/plugin/lock";
import { installFromDir, installFromTarball } from "../../src/commands/plugins/plugin/install-handlers";

let root = "";
let originalPluginsDir: string | undefined;
let originalPluginsLock: string | undefined;
let originalMawJsPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-install-handlers-final-"));
  originalPluginsDir = process.env.MAW_PLUGINS_DIR;
  originalPluginsLock = process.env.MAW_PLUGINS_LOCK;
  originalMawJsPath = process.env.MAW_JS_PATH;
  process.env.MAW_PLUGINS_DIR = join(root, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(root, "plugins.lock");
  process.env.MAW_JS_PATH = root;
  mkdirSync(process.env.MAW_PLUGINS_DIR, { recursive: true });
});

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR;
  else process.env.MAW_PLUGINS_DIR = originalPluginsDir;
  if (originalPluginsLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalPluginsLock;
  if (originalMawJsPath === undefined) delete process.env.MAW_JS_PATH;
  else process.env.MAW_JS_PATH = originalMawJsPath;
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string, name = "collision-plugin") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), "export default () => ({ ok: true });\n");
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "0.1.0",
    sdk: "*",
    target: "js",
    entry: "./index.js",
    capabilities: [],
    artifact: { path: "./index.js", sha256: null },
  }, null, 2));
}

function buildTarball(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const body = "export default () => ({ ok: true });\n";
  const sha256 = "sha256:" + createHash("sha256").update(body).digest("hex");
  writeFileSync(join(dir, "index.js"), body);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "0.1.0",
    sdk: "*",
    target: "js",
    entry: "./index.js",
    capabilities: [],
    artifact: { path: "./index.js", sha256 },
  }, null, 2));
  const tarball = join(root, name + ".tgz");
  const result = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json", "index.js"]);
  if (result.status !== 0) throw new Error(String(result.stderr));
  return { tarball, sha256 };
}

describe("plugin install handlers final coverage", () => {
  test("installFromDir refuses to overwrite an existing symlink without --force", async () => {
    const incoming = join(root, "incoming");
    const linked = join(root, "linked-target");
    writePlugin(incoming);
    mkdirSync(linked, { recursive: true });
    symlinkSync(linked, join(process.env.MAW_PLUGINS_DIR!, "collision-plugin"), "dir");

    await expect(installFromDir(incoming)).rejects.toThrow(/pass --force to overwrite/);
  });

  test("installFromTarball reports the override hint on pinned sha mismatch", async () => {
    const { tarball } = buildTarball("mismatch-plugin");
    writeFileSync(process.env.MAW_PLUGINS_LOCK!, JSON.stringify({
      schema: LOCK_SCHEMA,
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        "mismatch-plugin": {
          version: "0.1.0",
          sha256: "sha256:" + "b".repeat(64),
          source: tarball,
          added: "2026-05-18T00:00:00.000Z",
        },
      },
    }, null, 2));

    await expect(installFromTarball(tarball, { source: tarball })).rejects.toThrow(/--force to override \(updates lock\), --pin to re-pin/);
  });
});
