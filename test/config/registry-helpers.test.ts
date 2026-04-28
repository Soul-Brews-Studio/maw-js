/**
 * Tests for src/plugin/registry-helpers.ts — hashFile, isDevModeInstall, scanDirs, runtimeSdkVersion.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import {
  hashFile,
  isDevModeInstall,
  scanDirs,
  runtimeSdkVersion,
  __resetDiscoverStateForTests,
} from "../../src/plugin/registry-helpers";

describe("hashFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns sha256: prefix", () => {
    const file = join(tmp, "test.txt");
    writeFileSync(file, "hello");
    expect(hashFile(file)).toMatch(/^sha256:/);
  });

  it("returns correct hash for known content", () => {
    const file = join(tmp, "test.txt");
    const content = "hello world";
    writeFileSync(file, content);
    const expected = createHash("sha256").update(Buffer.from(content)).digest("hex");
    expect(hashFile(file)).toBe(`sha256:${expected}`);
  });

  it("returns different hashes for different content", () => {
    const file1 = join(tmp, "a.txt");
    const file2 = join(tmp, "b.txt");
    writeFileSync(file1, "content A");
    writeFileSync(file2, "content B");
    expect(hashFile(file1)).not.toBe(hashFile(file2));
  });

  it("returns same hash for same content", () => {
    const file1 = join(tmp, "a.txt");
    const file2 = join(tmp, "b.txt");
    writeFileSync(file1, "same content");
    writeFileSync(file2, "same content");
    expect(hashFile(file1)).toBe(hashFile(file2));
  });

  it("handles empty file", () => {
    const file = join(tmp, "empty.txt");
    writeFileSync(file, "");
    const expected = createHash("sha256").update(Buffer.from("")).digest("hex");
    expect(hashFile(file)).toBe(`sha256:${expected}`);
  });

  it("handles binary content", () => {
    const file = join(tmp, "binary.bin");
    writeFileSync(file, Buffer.from([0x00, 0xff, 0x42, 0x13]));
    const result = hashFile(file);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws for non-existent file", () => {
    expect(() => hashFile(join(tmp, "nope.txt"))).toThrow();
  });
});

describe("isDevModeInstall", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for symlink", () => {
    const target = join(tmp, "real-dir");
    const link = join(tmp, "link-dir");
    mkdirSync(target);
    symlinkSync(target, link);
    expect(isDevModeInstall(link)).toBe(true);
  });

  it("returns false for regular directory", () => {
    const dir = join(tmp, "regular");
    mkdirSync(dir);
    expect(isDevModeInstall(dir)).toBe(false);
  });

  it("returns false for non-existent path", () => {
    expect(isDevModeInstall(join(tmp, "nope"))).toBe(false);
  });

  it("returns false for regular file", () => {
    const file = join(tmp, "file.txt");
    writeFileSync(file, "content");
    expect(isDevModeInstall(file)).toBe(false);
  });
});

describe("scanDirs", () => {
  const origEnv = process.env.MAW_PLUGINS_DIR;

  afterEach(() => {
    if (origEnv !== undefined) process.env.MAW_PLUGINS_DIR = origEnv;
    else delete process.env.MAW_PLUGINS_DIR;
  });

  it("returns an array", () => {
    expect(Array.isArray(scanDirs())).toBe(true);
  });

  it("returns single directory", () => {
    expect(scanDirs()).toHaveLength(1);
  });

  it("uses MAW_PLUGINS_DIR when set", () => {
    process.env.MAW_PLUGINS_DIR = "/custom/plugins";
    expect(scanDirs()[0]).toBe("/custom/plugins");
  });

  it("defaults to ~/.maw/plugins when env not set", () => {
    delete process.env.MAW_PLUGINS_DIR;
    const result = scanDirs()[0];
    expect(result).toContain(".maw");
    expect(result).toContain("plugins");
  });
});

describe("runtimeSdkVersion", () => {
  beforeEach(() => {
    __resetDiscoverStateForTests();
  });

  it("returns a semver string", () => {
    const v = runtimeSdkVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns same value on repeated calls (cached)", () => {
    const v1 = runtimeSdkVersion();
    const v2 = runtimeSdkVersion();
    expect(v1).toBe(v2);
  });

  it("is not 0.0.0 (actual SDK version loaded)", () => {
    expect(runtimeSdkVersion()).not.toBe("0.0.0");
  });
});
