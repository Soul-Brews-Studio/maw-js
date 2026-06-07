import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  LOCK_SCHEMA,
  pinPlugin,
  readLock,
  recordInstall,
  validateName,
  validateSchema,
  writeLock,
} from "../../src/vendor/mpr-plugins/init/internal/plugin-lock";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let tmp = "";
let originalLock: string | undefined;

beforeEach(() => {
  originalLock = process.env.MAW_PLUGINS_LOCK;
  tmp = mkdtempSync(join(tmpdir(), "maw-init-plugin-lock-next-"));
  process.env.MAW_PLUGINS_LOCK = join(tmp, "nested", "plugins.lock");
});

afterEach(() => {
  if (originalLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalLock;
  rmSync(tmp, { recursive: true, force: true });
});

function nameError(name: string): string {
  const result = validateName(name);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

function schemaError(parsed: unknown): string {
  const result = validateSchema(parsed);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

function buildTarball(opts: {
  name: string;
  version?: string;
  manifestPatch?: Record<string, unknown>;
  files?: Record<string, string>;
}): { tarball: string; hashes: Record<string, string> } {
  const dir = mkdtempSync(join(tmp, "fixture-"));
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: opts.name,
    version: opts.version ?? "0.1.0",
    sdk: "^1.0.0",
    target: "js",
    capabilities: [],
    artifact: { path: "dist/index.js", sha256: `sha256:${HASH_A}` },
    ...opts.manifestPatch,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  const hashes: Record<string, string> = {};
  const files = opts.files ?? { "dist/index.js": "export default () => ({ ok: true });\n" };
  for (const [relativePath, body] of Object.entries(files)) {
    const file = join(dir, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    hashes[relativePath] = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  const tarball = join(dir, `${opts.name}-${manifest.version}.tgz`);
  const result = spawnSync("tar", ["-czf", tarball, "-C", dir, "plugin.json", ...Object.keys(files)]);
  if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr)}`);
  return { tarball, hashes };
}

describe("vendor init plugin-lock next coverage", () => {
  test("validators report empty names plus top-level and per-entry schema errors", () => {
    expect(nameError("")).toBe("plugin name required");

    expect(schemaError(null)).toContain("not a JSON object");
    expect(schemaError({ plugins: {} })).toContain("missing numeric 'schema'");
    expect(schemaError({ schema: LOCK_SCHEMA + 1, plugins: {} })).toContain("migration:");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: null } })).toContain("entry 'tool' is not an object");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { sha256: HASH_A, source: "./tool.tgz" } } })).toContain(
      "missing 'version'",
    );
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { version: "1.0.0", source: "./tool.tgz" } } })).toContain(
      "missing 'sha256'",
    );
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { version: "1.0.0", sha256: HASH_A } } })).toContain(
      "missing 'source'",
    );
  });

  test("readLock and writeLock surface malformed files and failed staging paths", () => {
    const lockFile = process.env.MAW_PLUGINS_LOCK!;
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, "{ not json");

    expect(() => readLock()).toThrow(/plugins\.lock: invalid JSON/);

    mkdirSync(`${lockFile}.tmp`, { recursive: true });
    expect(() =>
      writeLock({
        schema: LOCK_SCHEMA,
        updated: "2026-05-18T00:00:00.000Z",
        plugins: {},
      }),
    ).toThrow(/plugins\.lock: failed to stage/);
    expect(existsSync(lockFile)).toBe(true);
  });

  test("recordInstall rejects missing source before mutating the lock", () => {
    expect(() => recordInstall({ name: "tool", version: "1.0.0", sha256: HASH_A, source: "" })).toThrow(/source required/);
    expect(readLock().plugins.tool).toBeUndefined();
  });

  test("pinPlugin covers missing sources, artifact-path hashes, and missing artifacts", () => {
    expect(() => pinPlugin("ghost", join(tmp, "missing.tgz"))).toThrow(/source not found/);

    const body = "export default function artifactPlugin() { return 'artifact'; }\n";
    const artifact = buildTarball({
      name: "artifact-tool",
      files: { "dist/index.js": body },
    });
    const pinned = pinPlugin("artifact-tool", artifact.tarball);
    expect(pinned.entry).toMatchObject({
      version: "0.1.0",
      sha256: artifact.hashes["dist/index.js"],
      source: artifact.tarball,
    });
    expect(readLock().plugins["artifact-tool"].sha256).toBe(artifact.hashes["dist/index.js"]);

    const missingArtifact = buildTarball({
      name: "missing-artifact",
      manifestPatch: { artifact: { path: "dist/missing.js", sha256: `sha256:${HASH_B}` } },
      files: {},
    });
    expect(() => pinPlugin("missing-artifact", missingArtifact.tarball)).toThrow(/artifact missing at dist\/missing\.js/);
  });
});
