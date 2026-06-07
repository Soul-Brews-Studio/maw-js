import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const created: string[] = [];
const originalEnv = {
  CONSENT_PENDING_DIR: process.env.CONSENT_PENDING_DIR,
  CONSENT_TRUST_FILE: process.env.CONSENT_TRUST_FILE,
  MAW_PLUGIN_CAP_INFER: process.env.MAW_PLUGIN_CAP_INFER,
  MAW_QUIET: process.env.MAW_QUIET,
  MAW_WARN_STATE_FILE: process.env.MAW_WARN_STATE_FILE,
};

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.MAW_QUIET = "1";
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function pendingRequest(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    from: "node-a",
    to: "node-b",
    action: "plugin-install",
    summary: "Install demo plugin",
    pinHash: "sha256:abc",
    createdAt: "2026-05-18T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    status: "pending",
    ...patch,
  } as any;
}

describe("coverage-next plugin registry, consent, and helper seams", () => {
  test("legacy plugin warning persists throttle state without using the test bypass", async () => {
    const stateFile = join(tempDir("maw-warn-state-"), "nested", "session-warnings.state");
    process.env.MAW_WARN_STATE_FILE = stateFile;

    const registry = await import("../../src/plugin/registry-helpers.ts?coverage-next-plugin-registry-state");
    registry.warnLegacyOnce(2);
    registry.warnLegacyOnce(2);

    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state["legacy-plugin-warning"].lastShownMs).toBeNumber();
  });

  test("consent pending store handles corrupt files, deletion misses, deletion hits, and expiry", async () => {
    const dir = tempDir("maw-consent-pending-");
    process.env.CONSENT_PENDING_DIR = dir;
    process.env.CONSENT_TRUST_FILE = join(dir, "trust.json");
    const consent = await import("../../src/core/consent/store.ts?coverage-next-plugin-consent");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{not-json");
    expect(consent.readPending("bad")).toBeNull();
    expect(consent.deletePending("missing")).toBe(false);

    consent.writePending(pendingRequest("ok"));
    expect(consent.readPending("ok")?.status).toBe("pending");
    expect(consent.deletePending("ok")).toBe(true);
    expect(consent.readPending("ok")).toBeNull();

    expect(consent.applyExpiry(pendingRequest("old", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    }), Date.now()).status).toBe("expired");
  });

  test("update plugin symlink healing covers refreshed, pruned, and restore paths", async () => {
    const root = tempDir("maw-update-helper-");
    const pluginDir = join(root, "plugins");
    const sourceRoot = join(root, "source");
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(join(sourceRoot, "healed"), { recursive: true });
    mkdirSync(join(sourceRoot, "linked"), { recursive: true });
    writeFileSync(join(sourceRoot, "healed", "plugin.json"), "{}");
    writeFileSync(join(sourceRoot, "linked", "index.ts"), "export default {};");
    symlinkSync(join(root, "missing-healed"), join(pluginDir, "healed"));
    symlinkSync(join(root, "missing-pruned"), join(pluginDir, "pruned"));

    const update = await import("../../src/cli/cmd-update.ts?coverage-next-plugin-update-helpers");
    expect(update.healBrokenPluginSymlinks(pluginDir, [sourceRoot])).toEqual({ healed: 1, pruned: 1 });
    expect(existsSync(join(pluginDir, "healed"))).toBe(true);
    expect(existsSync(join(pluginDir, "pruned"))).toBe(false);

    expect(update.linkBundledPluginRoots(pluginDir, [sourceRoot])).toBe(1);
    expect(existsSync(join(pluginDir, "linked"))).toBe(true);

    const home = join(root, "home");
    const global = join(home, ".bun", "install", "global");
    const cache = join(home, ".bun", "install", "cache");
    mkdirSync(global, { recursive: true });
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(global, "package.json"), JSON.stringify({
      dependencies: { "maw-js": "old", maw: "old", keep: "yes" },
    }));
    writeFileSync(join(global, "bun.lock"), "lock");
    mkdirSync(join(cache, "maw-js-cache-entry"), { recursive: true });

    const restore = update.clearBunGlobalResolverState(home);
    expect(JSON.parse(readFileSync(join(global, "package.json"), "utf8")).dependencies).toEqual({ keep: "yes" });
    expect(existsSync(join(global, "bun.lock"))).toBe(false);
    expect(existsSync(join(cache, "maw-js-cache-entry"))).toBe(false);
    restore();
    expect(JSON.parse(readFileSync(join(global, "package.json"), "utf8")).dependencies).toMatchObject({
      "maw-js": "old",
      maw: "old",
      keep: "yes",
    });
  });

  test("plugin capability regex fallback detects SDK, filesystem, process, ffi, and fetch use", async () => {
    const build = await import("../../src/commands/plugins/plugin/build-impl.ts?coverage-next-plugin-build-regex");
    const source = [
      "import { readFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "import { dlopen } from 'bun:ffi';",
      "maw.identity();",
      "maw.wake();",
      "fetch('https://example.test');",
    ].join("\n");

    expect(build.inferCapabilitiesRegex(source)).toEqual([
      "ffi:any",
      "fs:read",
      "net:fetch",
      "proc:spawn",
      "sdk:identity",
      "sdk:wake",
    ]);

    process.env.MAW_PLUGIN_CAP_INFER = "regex";
    expect(build.inferCapabilities(source)).toContain("net:fetch");
  });
});
