/** Next-pass isolated coverage for src/commands/plugins/plugin/lock.ts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  LOCK_SCHEMA,
  pinPlugin,
  readLock,
  validateSchema,
  writeLock,
} from "../../src/commands/plugins/plugin/lock";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let tmp = "";
let originalLock: string | undefined;

beforeEach(() => {
  originalLock = process.env.MAW_PLUGINS_LOCK;
  tmp = mkdtempSync(join(tmpdir(), "maw-plugin-lock-next-"));
  process.env.MAW_PLUGINS_LOCK = join(tmp, "nested", "plugins.lock");
});

afterEach(() => {
  if (originalLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
  else process.env.MAW_PLUGINS_LOCK = originalLock;
  rmSync(tmp, { recursive: true, force: true });
});

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
    artifact: { path: "./index.js", sha256: `sha256:${HASH_A}` },
    ...opts.manifestPatch,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  const hashes: Record<string, string> = {};
  const files = opts.files ?? { "index.js": "export default () => ({ ok: true });\n" };
  for (const [relativePath, body] of Object.entries(files)) {
    const filePath = join(dir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
    hashes[relativePath] = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  const tarball = join(dir, `${opts.name}-${manifest.version}.tgz`);
  const tarArgs = ["-czf", tarball, "-C", dir, "plugin.json", ...Object.keys(files)];
  const result = spawnSync("tar", tarArgs);
  if (result.status !== 0) {
    throw new Error(`tar failed: ${String(result.stderr)}`);
  }
  return { tarball, hashes };
}

describe("plugin lock schema next-pass coverage", () => {
  test("validateSchema reports every unsafe top-level and per-entry shape", () => {
    expect(schemaError(null)).toContain("not a JSON object");
    expect(schemaError({ plugins: {} })).toContain("missing numeric 'schema'");
    expect(schemaError({ schema: 99, plugins: {} })).toContain("unknown schema 99");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: [] })).toContain("'plugins' must be an object");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { "BadName": {} } })).toContain("invalid plugin name");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: null } })).toContain("entry 'tool' is not an object");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { sha256: HASH_A, source: "./tool.tgz" } } })).toContain("missing 'version'");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { version: "1.0.0", source: "./tool.tgz" } } })).toContain("missing 'sha256'");
    expect(schemaError({ schema: LOCK_SCHEMA, plugins: { tool: { version: "1.0.0", sha256: HASH_A } } })).toContain("missing 'source'");

    const valid = validateSchema({
      schema: LOCK_SCHEMA,
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        tool: {
          version: "1.0.0",
          sha256: `sha256:${HASH_B}`,
          source: "./tool.tgz",
          signers: ["alice", 42, "bob"],
          linked: true,
        },
      },
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.lock.plugins.tool.added).toBe("2026-05-18T00:00:00.000Z");
      expect(valid.lock.plugins.tool.signers).toEqual(["alice", "bob"]);
      expect(valid.lock.plugins.tool.linked).toBe(true);
    }
  });

  test("writeLock surfaces staging write failures without clobbering the target path", () => {
    const lockFile = process.env.MAW_PLUGINS_LOCK!;
    mkdirSync(dirname(lockFile), { recursive: true });
    mkdirSync(`${lockFile}.tmp`, { recursive: true });

    expect(() =>
      writeLock({
        schema: LOCK_SCHEMA,
        updated: "2026-05-18T00:00:00.000Z",
        plugins: {},
      }),
    ).toThrow(/plugins\.lock: failed to stage/);
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("plugin lock pinPlugin next-pass coverage", () => {
  test("pinPlugin hashes source-shaped entry bytes and rejects invalid pin names before hashing", () => {
    const body = "export default function plugin() { return 'source-shaped'; }\n";
    const fixture = buildTarball({
      name: "source-shaped",
      manifestPatch: {
        entry: "src/index.js",
        artifact: { path: "dist/index.js", sha256: null },
      },
      files: { "src/index.js": body },
    });

    expect(() => pinPlugin("BadName", fixture.tarball)).toThrow(/invalid plugin name/);

    const result = pinPlugin("source-shaped", fixture.tarball, { signers: ["alice"] });
    expect(result.entry).toMatchObject({
      version: "0.1.0",
      sha256: fixture.hashes["src/index.js"],
      source: fixture.tarball,
      signers: ["alice"],
    });
    expect(readLock().plugins["source-shaped"].sha256).toBe(fixture.hashes["src/index.js"]);
  });

  test("pinPlugin reports unresolved tarball manifests and missing artifacts", () => {
    const unresolved = buildTarball({
      name: "unresolved",
      manifestPatch: { artifact: undefined },
      files: {},
    });
    const missingArtifact = buildTarball({
      name: "missing-artifact",
      manifestPatch: { artifact: { path: "missing.js", sha256: `sha256:${HASH_A}` } },
      files: {},
    });

    expect(() => pinPlugin("unresolved", unresolved.tarball)).toThrow(/no 'artifact' or 'entry' field/);
    expect(() => pinPlugin("missing-artifact", missingArtifact.tarball)).toThrow(/artifact missing at missing\.js/);
  });
});
