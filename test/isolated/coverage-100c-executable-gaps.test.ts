import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";
import * as realOs from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempRoot = mkdtempSync(join(tmpdir(), "maw-coverage-100c-"));
let fakeHome = join(tempRoot, "home");
let spawnSyncImpl: typeof realChildProcess.spawnSync = realChildProcess.spawnSync;

mock.module("os", () => ({
  ...realOs,
  homedir: () => fakeHome,
}));

mock.module("child_process", () => ({
  ...realChildProcess,
  spawnSync: (...args: Parameters<typeof realChildProcess.spawnSync>) => spawnSyncImpl(...args),
}));

function resetEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const originalFetch = globalThis.fetch;
const originalEnv = {
  MAW_CONFIG_DIR: process.env.MAW_CONFIG_DIR,
  MAW_HOME: process.env.MAW_HOME,
  MAW_SDK_RUST_PATH: process.env.MAW_SDK_RUST_PATH,
};
const originalWarn = console.warn;

beforeEach(() => {
  fakeHome = join(tempRoot, `home-${crypto.randomUUID()}`);
  mkdirSync(fakeHome, { recursive: true });
  spawnSyncImpl = realChildProcess.spawnSync;
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  resetEnv("MAW_CONFIG_DIR", originalEnv.MAW_CONFIG_DIR);
  resetEnv("MAW_HOME", originalEnv.MAW_HOME);
  resetEnv("MAW_SDK_RUST_PATH", originalEnv.MAW_SDK_RUST_PATH);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  resetEnv("MAW_CONFIG_DIR", originalEnv.MAW_CONFIG_DIR);
  resetEnv("MAW_HOME", originalEnv.MAW_HOME);
  resetEnv("MAW_SDK_RUST_PATH", originalEnv.MAW_SDK_RUST_PATH);
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("coverage 100c executable gap tests", () => {
  test("defaultRustSdkPath uses the portable bun-global SDK before dev-tree fallback", async () => {
    delete process.env.MAW_SDK_RUST_PATH;
    const sdk = join(fakeHome, ".bun", "install", "global", "node_modules", "maw", "src", "wasm", "maw-plugin-sdk");
    mkdirSync(sdk, { recursive: true });

    const { defaultRustSdkPath } = await import("../../src/commands/shared/plugin-create-scaffold");

    expect(defaultRustSdkPath()).toBe(sdk);
  });

  test("hub workspace config loader creates the dir, keeps valid configs, and reports malformed files", async () => {
    const configDir = join(tempRoot, `hub-${crypto.randomUUID()}`);
    process.env.MAW_CONFIG_DIR = configDir;
    delete process.env.MAW_HOME;

    const hub = await import("../../src/transports/hub-config");

    expect(hub.loadWorkspaceConfigs()).toEqual([]);
    expect(realFs.existsSync(hub.WORKSPACES_DIR)).toBe(true);

    writeFileSync(join(hub.WORKSPACES_DIR, "valid.json"), JSON.stringify({
      id: "alpha",
      hubUrl: "wss://hub.example.test",
      token: "secret",
      sharedAgents: ["mawjs"],
    }));
    writeFileSync(join(hub.WORKSPACES_DIR, "invalid.json"), JSON.stringify({
      id: "bad",
      hubUrl: "https://not-websocket.example.test",
      token: "secret",
      sharedAgents: [],
    }));
    writeFileSync(join(hub.WORKSPACES_DIR, "broken.json"), "{not json");
    writeFileSync(join(hub.WORKSPACES_DIR, "notes.txt"), "ignored");

    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    expect(hub.loadWorkspaceConfigs()).toEqual([{ id: "alpha", hubUrl: "wss://hub.example.test", token: "secret", sharedAgents: ["mawjs"] }]);
    expect(warnings.join("\n")).toContain("invalid workspace config: invalid.json");
    expect(warnings.join("\n")).toContain("failed to parse workspace config: broken.json");
  });

  test("plugin install extraction rejects traversal, oversized bodies, and missing source entries", async () => {
    spawnSyncImpl = ((command: string, args: string[]) => {
      if (command === "tar" && args.includes("-tzf")) {
        return { status: 0, stdout: "plugin.json\n../escape.txt\n", stderr: "" } as unknown as ReturnType<typeof realChildProcess.spawnSync>;
      }
      return { status: 0, stdout: "", stderr: "" } as unknown as ReturnType<typeof realChildProcess.spawnSync>;
    }) as typeof realChildProcess.spawnSync;

    const extraction = await import("../../src/commands/plugins/plugin/install-extraction");

    const traversal = extraction.extractTarball("plugin.tgz", tempRoot);
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error).toContain("path traversal");

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/gzip" }),
      arrayBuffer: async () => new ArrayBuffer(50 * 1024 * 1024 + 1),
    } as Response)) as typeof fetch;
    const tooLarge = await extraction.downloadTarball("https://example.test/plugin.tgz");
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error).toContain("response body");

    const noArtifact = extraction.verifyArtifactHashAgainst(tempRoot, { name: "missing", version: "1.0.0", sdk: "^1" } as never, "sha256:none");
    expect(noArtifact.ok).toBe(false);
    if (!noArtifact.ok) expect(noArtifact.error).toContain("tarball manifest has no");
    expect(extraction.verifyArtifactHash(tempRoot, { name: "source", version: "1.0.0", sdk: "^1", entry: "src/index.ts" } as never)).toEqual({
      ok: false,
      error: "source entry missing at src/index.ts",
    });
  });

  test("downloadTarball preserves the fallback filename for root URLs", async () => {
    const extraction = await import("../../src/commands/plugins/plugin/install-extraction");
    globalThis.fetch = (async () => new Response(new Uint8Array([7, 8, 9]), {
      headers: { "content-type": "application/gzip" },
    })) as typeof fetch;

    const downloaded = await extraction.downloadTarball("https://example.test/");
    expect(downloaded.ok).toBe(true);
    if (downloaded.ok) {
      expect(downloaded.path.endsWith("/plugin.tgz")).toBe(true);
      expect(Array.from(readFileSync(downloaded.path))).toEqual([7, 8, 9]);
      rmSync(join(downloaded.path, ".."), { recursive: true, force: true });
    }
  });
});
