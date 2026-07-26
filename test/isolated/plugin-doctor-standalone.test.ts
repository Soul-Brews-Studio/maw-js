import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const doctorDir = join(root, "src/vendor/mpr-plugins/doctor");

let tmpRoot = "";
let config: Record<string, unknown> = {};
let manifestEntries: unknown[] = [];
let invalidated = 0;

const C = {
  green: "",
  yellow: "",
  red: "",
  gray: "",
  reset: "",
};

function tmpPath(...parts: string[]) {
  return join(tmpRoot || tmpdir(), ...parts);
}

const sdkMock = {
  C,
  loadConfig: () => config,
  invalidateManifest: () => { invalidated += 1; },
  loadManifestCached: () => manifestEntries,
  isMawXdgEnabled: () => true,
  legacyMawPath: (...parts: string[]) => tmpPath("legacy-maw", ...parts),
  mawCacheDir: () => tmpPath("cache"),
  mawConfigDir: () => tmpPath("config"),
  mawDataDir: () => tmpPath("data"),
  mawDataPath: (...parts: string[]) => tmpPath("data", ...parts),
  mawStateDir: () => tmpPath("state"),
  mawStatePath: (...parts: string[]) => tmpPath("state", ...parts),
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/maw-js-branch-check.ts"), () => ({
  checkMawJsBranch: async () => ({ name: "maw-js:branch", ok: true, message: "mock branch ok" }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stillborn-worktrees.ts"), () => ({
  checkStillbornWorktrees: () => ({ name: "worktrees:stillborn", ok: true, message: "mock worktrees ok" }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/bun-link-detect.ts"), () => ({
  detectBunLinkedCheckout: () => null,
}));

const { command, default: doctorHandler } = await import("../../src/vendor/mpr-plugins/doctor/index.ts?plugin-doctor-standalone");
const peersStore = await import("../../src/vendor/mpr-plugins/doctor/internal/peers-store.ts?plugin-doctor-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `maw-doctor-standalone-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpPath("state"), { recursive: true });
  config = { oracle: "local", node: "home" };
  manifestEntries = [];
  invalidated = 0;
  process.env.PEERS_FILE = tmpPath("state", "peers.json");
  process.env.MAW_TEST_MODE = "1";
  process.env.MAW_PEER_STALE_TTL_MS = String(24 * 60 * 60 * 1000);
});

afterEach(() => {
  delete process.env.PEERS_FILE;
  delete process.env.MAW_TEST_MODE;
  delete process.env.MAW_PEER_STALE_TTL_MS;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

describe("doctor plugin standalone boundary (#2328)", () => {
  test("all doctor sources use SDK or local/platform imports only", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "doctor",
      root,
      allowMawJs: ["maw-js/core/gateway"],
      allowRelative: [/^(?:\.\.\/){3}core\/tasks\/hey-spawn$/], // kobo-405: shared fail-closed-under-test hey spawn seam
    });

    expect(command).toMatchObject({ name: "doctor" });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");

    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(imports.map((record) => record.spec)).toContain("maw-js/core/gateway");
    for (const symbol of ["C", "loadConfig", "loadManifestCached", "invalidateManifest", "mawStatePath", "isMawXdgEnabled", "mawCacheDir"]) {
      expect(sdk).toContain(symbol);
    }
  });

  test("API peers check runs through SDK-backed config and peer store", async () => {
    peersStore.savePeers({
      version: 1,
      peers: {
        alpha: {
          url: "http://alpha.local",
          node: "alpha-node",
          addedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          identity: { oracle: "remote", node: "alpha" },
        },
      },
    });

    const result = await doctorHandler({ source: "api", args: { check: "peers" } } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("peers:duplicates: no <oracle>:<node> collisions across 1 peer");
    expect(output).toContain("peers:stale: no stale peers");
  });

  test("CLI --fix-stale removes stale peers through the plugin-local store", async () => {
    const now = Date.now();
    peersStore.savePeers({
      version: 1,
      peers: {
        stale: {
          url: "http://stale.local",
          node: "stale-node",
          addedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
          lastSeen: null,
        },
        fresh: {
          url: "http://fresh.local",
          node: "fresh-node",
          addedAt: new Date(now).toISOString(),
          lastSeen: new Date(now).toISOString(),
        },
      },
    });

    const result = await doctorHandler({ source: "cli", args: ["--fix-stale"] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("peers:fix-stale: removed 1 stale peer");
    expect(Object.keys(peersStore.loadPeers().peers)).toEqual(["fresh"]);
  });

  test("manifest check uses SDK manifest helpers", async () => {
    const result = await doctorHandler({ source: "cli", args: ["manifest"] } as any);

    expect(result.ok).toBe(true);
    expect(invalidated).toBe(1);
    expect(stripAnsi(result.output)).toContain("manifest:cross-source");
  });

  test("hub json mode reports fix commands and before/after state", async () => {
    mkdirSync(tmpPath("data", "workspaces"), { recursive: true });
    writeFileSync(tmpPath("data", "workspaces", "valid.json"), JSON.stringify({ url: "https://hub.example.test" }));
    writeFileSync(tmpPath("state", "doctor-last.json"), JSON.stringify({
      timestamp: "2026-06-08T00:00:00.000Z",
      checks: { hub: "ok" },
    }));

    const result = await doctorHandler({ source: "cli", args: ["hub", "--json", "--no-prompt"] } as any);

    expect(result.ok).toBe(false);
    const parsed = JSON.parse(stripAnsi(result.output));
    expect(parsed.checks[0]).toMatchObject({
      name: "hub",
      ok: false,
      severity: "warn",
      fix: [expect.stringContaining("rm ")],
    });
    expect(parsed.comparison).toContainEqual({ name: "hub", before: "ok", after: "issue", status: "regressed" });
    expect(JSON.parse(readFileSync(tmpPath("state", "doctor-last.json"), "utf8")).checks.hub).toBe("issue");
  });

  test("gateway check skips when rust gateway is not selected", async () => {
    config = { oracle: "local", node: "home", gateway: "bun" };

    const result = await doctorHandler({ source: "cli", args: ["gateway"] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("gateway: gateway bun selected — rust probe skipped");
  });

  test("gateway check reports missing rust gateway binary", async () => {
    config = { oracle: "local", node: "home", gateway: "rust" };
    const previous = process.env.MAW_GATEWAY_BIN;
    process.env.MAW_GATEWAY_BIN = tmpPath("missing", "maw-gateway");
    try {
      const result = await doctorHandler({ source: "cli", args: ["gateway", "--json", "--no-prompt"] } as any);

      expect(result.ok).toBe(false);
      const parsed = JSON.parse(stripAnsi(result.output));
      expect(parsed.checks[0]).toMatchObject({
        name: "gateway:rust",
        ok: false,
        severity: "error",
      });
      expect(parsed.checks[0].message).toContain("binary not found on PATH");
      expect(parsed.checks[0].fix[0]).toContain("cargo build --release");
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
    }
  });

  test("gateway check reports OK for proxy-capable rust gateway binary", async () => {
    config = { oracle: "local", node: "home", gateway: "rust" };
    const binary = tmpPath("maw-gateway-ok");
    const previous = process.env.MAW_GATEWAY_BIN;
    writeFileSync(binary, `#!/bin/sh\necho "listening on :$3"\nexec sleep 30\n`);
    chmodSync(binary, 0o755);
    process.env.MAW_GATEWAY_BIN = binary;
    try {
      const result = await doctorHandler({ source: "cli", args: ["gateway", "--json", "--no-prompt"] } as any);

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(stripAnsi(result.output));
      expect(parsed.checks[0]).toMatchObject({
        name: "gateway:rust",
        ok: true,
        severity: "info",
      });
      expect(parsed.checks[0].message).toContain("starts OK");
      expect(parsed.checks[0].message).toContain("--backend supported");
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
    }
  });

  test("gateway check flags stale rust gateway binary that rejects --backend", async () => {
    config = { oracle: "local", node: "home", gateway: "rust" };
    const binary = tmpPath("maw-gateway-stale");
    const previous = process.env.MAW_GATEWAY_BIN;
    writeFileSync(binary, `#!/bin/sh\necho "usage: maw-gateway serve [--port PORT]" >&2\nexit 2\n`);
    chmodSync(binary, 0o755);
    process.env.MAW_GATEWAY_BIN = binary;
    try {
      const result = await doctorHandler({ source: "cli", args: ["gateway", "--json", "--no-prompt"] } as any);

      expect(result.ok).toBe(false);
      const parsed = JSON.parse(stripAnsi(result.output));
      expect(parsed.checks[0]).toMatchObject({
        name: "gateway:rust",
        ok: false,
        severity: "error",
      });
      expect(parsed.checks[0].message).toContain("stale binary");
      expect(parsed.checks[0].message).toContain("rejects --backend");
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
    }
  });

});
