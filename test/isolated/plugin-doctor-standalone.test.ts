import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

mock.module("maw-js/sdk", () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => sdkMock);
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

function walkSources(dir: string): string[] {
  const { readdirSync } = require("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) specs.add(match[1] ?? match[2]);
  return [...specs];
}

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
    const imports = walkSources(doctorDir).flatMap((file) => importSpecs(readFileSync(file, "utf8")));
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/lib/")
      || spec.startsWith("maw-js/config")
      || spec.startsWith("maw-js/plugin")
      || spec.includes("../../../core")
      || spec.includes("../../../../core"),
    );

    expect(command).toMatchObject({ name: "doctor" });
    expect(forbidden).toEqual([]);
    expect(imports).toContain("maw-js/sdk");

    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
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
});
