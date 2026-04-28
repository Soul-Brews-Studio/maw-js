/**
 * Tests for listSnapshots, loadSnapshot, latestSnapshot from src/core/fleet/snapshot.ts.
 * Uses mock.module to redirect SNAPSHOT_DIR and avoid mkdirSync at import.
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpBase = mkdtempSync(join(tmpdir(), "maw-snapshot-test-"));
const tmpSnapshots = join(tmpBase, "snapshots");
mkdirSync(tmpSnapshots, { recursive: true });

// Mock core/paths to avoid real mkdirSync
mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmpBase,
  FLEET_DIR: join(tmpBase, "fleet"),
  CONFIG_FILE: join(tmpBase, "maw.config.json"),
  MAW_ROOT: tmpBase,
  resolveHome: () => tmpBase,
}));

// Mock config
const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "test",
    ghqRoot: tmpBase,
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

// Mock ssh (listSessions)
mock.module("../../src/core/transport/ssh", () => ({
  listSessions: async () => [],
  hostExec: async () => "",
  sendKeys: async () => {},
  selectWindow: async () => {},
  capture: async () => "",
  getPaneCommand: async () => "",
  getPaneInfos: async () => ({}),
}));

const { listSnapshots, loadSnapshot, latestSnapshot } = await import("../../src/core/fleet/snapshot");

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

function writeSnapshot(filename: string, data: object) {
  writeFileSync(join(tmpSnapshots, filename), JSON.stringify(data, null, 2));
}

function clearSnapshots() {
  for (const f of readdirSync(tmpSnapshots)) {
    rmSync(join(tmpSnapshots, f));
  }
}

describe("listSnapshots", () => {
  it("returns empty array when no snapshots", () => {
    clearSnapshots();
    expect(listSnapshots()).toEqual([]);
  });

  it("lists snapshots newest first", () => {
    clearSnapshots();
    writeSnapshot("20260101-1200.json", {
      timestamp: "2026-01-01T12:00:00Z", trigger: "auto",
      sessions: [{ name: "s1", windows: [{ name: "w1" }] }],
    });
    writeSnapshot("20260102-1200.json", {
      timestamp: "2026-01-02T12:00:00Z", trigger: "wake",
      sessions: [],
    });
    const result = listSnapshots();
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe("20260102-1200.json"); // newest first
    expect(result[0].trigger).toBe("wake");
    expect(result[0].sessionCount).toBe(0);
    expect(result[1].windowCount).toBe(1);
  });

  it("handles malformed snapshot files gracefully", () => {
    clearSnapshots();
    writeFileSync(join(tmpSnapshots, "bad.json"), "not json{{{");
    const result = listSnapshots();
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe("?");
  });
});

describe("loadSnapshot", () => {
  it("loads by exact filename", () => {
    clearSnapshots();
    writeSnapshot("20260101-1200.json", {
      timestamp: "2026-01-01T12:00:00Z", trigger: "auto", sessions: [],
    });
    const result = loadSnapshot("20260101-1200.json");
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("auto");
  });

  it("loads by filename without extension", () => {
    clearSnapshots();
    writeSnapshot("20260101-1200.json", {
      timestamp: "2026-01-01T12:00:00Z", trigger: "auto", sessions: [],
    });
    const result = loadSnapshot("20260101-1200");
    expect(result).not.toBeNull();
  });

  it("loads by partial timestamp prefix", () => {
    clearSnapshots();
    writeSnapshot("20260101-1200.json", {
      timestamp: "2026-01-01T12:00:00Z", trigger: "auto", sessions: [],
    });
    const result = loadSnapshot("202601");
    expect(result).not.toBeNull();
  });

  it("returns null when not found", () => {
    clearSnapshots();
    expect(loadSnapshot("nonexistent")).toBeNull();
  });

  it("returns null for corrupted file", () => {
    clearSnapshots();
    writeFileSync(join(tmpSnapshots, "bad.json"), "corrupt");
    expect(loadSnapshot("bad.json")).toBeNull();
  });
});

describe("latestSnapshot", () => {
  it("returns null when no snapshots", () => {
    clearSnapshots();
    expect(latestSnapshot()).toBeNull();
  });

  it("returns the most recent snapshot", () => {
    clearSnapshots();
    writeSnapshot("20260101-1200.json", {
      timestamp: "2026-01-01T12:00:00Z", trigger: "auto", sessions: [],
    });
    writeSnapshot("20260102-1200.json", {
      timestamp: "2026-01-02T12:00:00Z", trigger: "wake", sessions: [],
    });
    const result = latestSnapshot();
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("wake");
  });
});
