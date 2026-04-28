/**
 * Tests for extractTarball, verifyArtifactHashAgainst, verifyArtifactHash
 * from src/commands/plugins/plugin/install-extraction.ts.
 * Uses real temp dirs + tar for extraction tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { extractTarball, verifyArtifactHashAgainst, verifyArtifactHash } from "../../src/commands/plugins/plugin/install-extraction";
import { hashFile } from "../../src/plugin/registry";
import type { PluginManifest } from "../../src/plugin/types";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function createTarball(entries: Record<string, string>): string {
  const staging = join(tmp, "staging");
  mkdirSync(staging, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    const dir = join(staging, name.includes("/") ? name.substring(0, name.lastIndexOf("/")) : "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(staging, name), content);
  }
  const tarPath = join(tmp, "test.tgz");
  spawnSync("tar", ["-czf", tarPath, "-C", staging, "."], { encoding: "utf8" });
  return tarPath;
}

// ─── extractTarball ─────────────────────────────────────────────────────────

describe("extractTarball", () => {
  it("extracts valid tarball successfully", () => {
    const tar = createTarball({ "hello.txt": "world" });
    const dest = join(tmp, "out");
    mkdirSync(dest);
    const result = extractTarball(tar, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, "hello.txt"))).toBe(true);
  });

  it("extracts nested directories", () => {
    const tar = createTarball({ "sub/deep.txt": "nested" });
    const dest = join(tmp, "out");
    mkdirSync(dest);
    const result = extractTarball(tar, dest);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, "sub", "deep.txt"))).toBe(true);
  });

  it("fails for nonexistent tarball", () => {
    const dest = join(tmp, "out");
    mkdirSync(dest);
    const result = extractTarball(join(tmp, "nope.tgz"), dest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tar list failed");
    }
  });

  it("fails for invalid tarball data", () => {
    const bad = join(tmp, "bad.tgz");
    writeFileSync(bad, "not a tarball");
    const dest = join(tmp, "out");
    mkdirSync(dest);
    const result = extractTarball(bad, dest);
    expect(result.ok).toBe(false);
  });
});

// ─── verifyArtifactHashAgainst ──────────────────────────────────────────────

describe("verifyArtifactHashAgainst", () => {
  it("returns ok for matching hash", () => {
    const artifactDir = join(tmp, "plugin");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "plugin.wasm"), "wasm content");
    const hash = hashFile(join(artifactDir, "plugin.wasm"));
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      artifact: { path: "plugin.wasm", sha256: hash },
    } as any;
    const result = verifyArtifactHashAgainst(artifactDir, manifest, hash);
    expect(result.ok).toBe(true);
  });

  it("fails for mismatched hash", () => {
    const artifactDir = join(tmp, "plugin");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "plugin.wasm"), "wasm content");
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      artifact: { path: "plugin.wasm", sha256: "wrong" },
    } as any;
    const result = verifyArtifactHashAgainst(artifactDir, manifest, "deadbeef");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("hash mismatch");
    }
  });

  it("fails when manifest has no artifact field", () => {
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
    } as any;
    const result = verifyArtifactHashAgainst(tmp, manifest, "hash");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no 'artifact' field");
    }
  });

  it("fails when artifact file is missing", () => {
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      artifact: { path: "missing.wasm", sha256: "abc" },
    } as any;
    const result = verifyArtifactHashAgainst(tmp, manifest, "abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("artifact missing");
    }
  });
});

// ─── verifyArtifactHash ─────────────────────────────────────────────────────

describe("verifyArtifactHash", () => {
  it("uses manifest embedded hash as expected", () => {
    const artifactDir = join(tmp, "plugin");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "plugin.wasm"), "wasm binary data");
    const hash = hashFile(join(artifactDir, "plugin.wasm"));
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      artifact: { path: "plugin.wasm", sha256: hash },
    } as any;
    expect(verifyArtifactHash(artifactDir, manifest).ok).toBe(true);
  });

  it("fails when artifact.sha256 is null", () => {
    const manifest: PluginManifest = {
      name: "test",
      version: "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      artifact: { path: "plugin.wasm", sha256: null },
    } as any;
    const result = verifyArtifactHash(tmp, manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sha256=null");
    }
  });

  it("fails when no artifact field", () => {
    const manifest = { name: "test", version: "1.0.0", wasm: "x", sdk: "1" } as any;
    expect(verifyArtifactHash(tmp, manifest).ok).toBe(false);
  });
});
