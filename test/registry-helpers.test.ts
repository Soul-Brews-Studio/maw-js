import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  __resetDiscoverStateForTests,
  hashFile,
  isDevModeInstall,
  runtimeSdkVersion,
  scanDirs,
  warnLegacyOnce,
} from "../src/plugin/registry-helpers";

const tempDirs: string[] = [];
const oldEnv: Record<string, string | undefined> = {};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function saveEnv(name: string): void {
  if (!(name in oldEnv)) oldEnv[name] = process.env[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete oldEnv[name];
  }
  __resetDiscoverStateForTests();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("plugin registry runtime helpers", () => {
  test("scanDirs honors MAW_PLUGINS_DIR override", () => {
    saveEnv("MAW_PLUGINS_DIR");
    process.env.MAW_PLUGINS_DIR = "/tmp/maw-test-plugins";
    expect(scanDirs()).toEqual(["/tmp/maw-test-plugins"]);
  });

  test("runtimeSdkVersion resolves and caches the bundled SDK package version", () => {
    __resetDiscoverStateForTests();
    const version = runtimeSdkVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(runtimeSdkVersion()).toBe(version);
  });

  test("hashFile returns manifest-compatible sha256 digests", () => {
    const dir = tempDir("maw-hash-");
    const file = join(dir, "plugin.js");
    writeFileSync(file, "hello plugin");
    const expected = createHash("sha256").update("hello plugin").digest("hex");
    expect(hashFile(file)).toBe(`sha256:${expected}`);
  });

  test("isDevModeInstall detects symlinked plugin installs and missing paths", () => {
    const dir = tempDir("maw-dev-mode-");
    const real = join(dir, "real-plugin");
    const link = join(dir, "linked-plugin");
    writeFileSync(real, "not a directory but still a real path");
    symlinkSync(real, link);

    expect(isDevModeInstall(link)).toBe(true);
    expect(isDevModeInstall(real)).toBe(false);
    expect(isDevModeInstall(join(dir, "missing"))).toBe(false);
  });

  test("warnLegacyOnce warns only once per module latch", () => {
    __resetDiscoverStateForTests();
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      warnLegacyOnce(2);
      warnLegacyOnce(3);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("2 legacy plugins loaded without artifact hash");
  });

  test("warnLegacyOnce persists a throttle state when not using the test bypass", async () => {
    const moduleUrl = `../src/plugin/registry-helpers.ts?fresh=${Date.now()}-${Math.random()}`;
    const fresh = await import(moduleUrl) as typeof import("../src/plugin/registry-helpers");
    saveEnv("MAW_WARN_STATE_FILE");
    const dir = tempDir("maw-warn-state-");
    const stateFile = join(dir, "nested", "warnings.json");
    process.env.MAW_WARN_STATE_FILE = stateFile;

    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      fresh.warnLegacyOnce(1);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("1 legacy plugin loaded without artifact hash");
    expect(existsSync(stateFile)).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))["legacy-plugin-warning"].lastShownMs).toBeGreaterThan(0);
  });
});
