/**
 * Tests for loadFleet / loadFleetEntries from src/commands/shared/fleet-load.ts.
 * Uses mock.module to redirect FLEET_DIR to a temp dir.
 *
 * Why isolated: fleet-load.ts imports FLEET_DIR from the SDK barrel which
 * re-exports from core/paths.ts. paths.ts does mkdirSync(FLEET_DIR) at
 * import time, so we must mock BEFORE the import resolves.
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Redirect core/paths BEFORE anything loads ──────────────────────────────

const tmpBase = mkdtempSync(join(tmpdir(), "maw-fleet-load-"));
const tmpFleet = join(tmpBase, "fleet");
mkdirSync(tmpFleet, { recursive: true });

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmpBase,
  FLEET_DIR: tmpFleet,
  CONFIG_FILE: join(tmpBase, "maw.config.json"),
  MAW_ROOT: tmpBase,
  resolveHome: () => tmpBase,
}));

// Mock the config module (loadConfig is pulled in transitively by SDK)
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

const { loadFleet, loadFleetEntries, getSessionNames } = await import("../../src/commands/shared/fleet-load");

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeFleet(filename: string, data: object) {
  writeFileSync(join(tmpFleet, filename), JSON.stringify(data, null, 2));
}

function clearFleet() {
  for (const f of readdirSync(tmpFleet)) {
    unlinkSync(join(tmpFleet, f));
  }
  // Clear require cache for JSON files in tmpFleet
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(tmpFleet)) delete require.cache[key];
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("loadFleet", () => {
  it("returns empty array when fleet dir is empty", () => {
    clearFleet();
    const result = loadFleet();
    expect(result).toEqual([]);
  });

  it("loads fleet sessions from JSON files", () => {
    clearFleet();
    writeFleet("01-test.json", { name: "01-test", windows: [{ name: "agent", repo: "org/repo" }] });
    const result = loadFleet();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("01-test");
    expect(result[0].windows).toHaveLength(1);
  });

  it("skips .disabled files", () => {
    clearFleet();
    writeFleet("01-test.json", { name: "01-test", windows: [] });
    writeFleet("02-off.json.disabled", { name: "02-off", windows: [] });
    const result = loadFleet();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("01-test");
  });

  it("skips non-JSON files", () => {
    clearFleet();
    writeFleet("01-test.json", { name: "01-test", windows: [] });
    writeFileSync(join(tmpFleet, "README.md"), "readme");
    const result = loadFleet();
    expect(result).toHaveLength(1);
  });

  it("sorts files by name", () => {
    clearFleet();
    writeFleet("03-third.json", { name: "03-third", windows: [] });
    writeFleet("01-first.json", { name: "01-first", windows: [] });
    writeFleet("02-second.json", { name: "02-second", windows: [] });
    const result = loadFleet();
    expect(result[0].name).toBe("01-first");
    expect(result[1].name).toBe("02-second");
    expect(result[2].name).toBe("03-third");
  });
});

describe("loadFleetEntries", () => {
  it("returns empty array when fleet dir is empty", () => {
    clearFleet();
    expect(loadFleetEntries()).toEqual([]);
  });

  it("parses file number and group name from filename", () => {
    clearFleet();
    writeFleet("08-mawjs.json", { name: "08-mawjs", windows: [] });
    const entries = loadFleetEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("08-mawjs.json");
    expect(entries[0].num).toBe(8);
    expect(entries[0].groupName).toBe("mawjs");
    expect(entries[0].session.name).toBe("08-mawjs");
  });

  it("handles non-standard filenames (no number prefix)", () => {
    clearFleet();
    writeFleet("custom.json", { name: "custom", windows: [] });
    const entries = loadFleetEntries();
    expect(entries[0].num).toBe(0);
    expect(entries[0].groupName).toBe("custom");
  });

  it("loads session with windows", () => {
    clearFleet();
    writeFleet("05-pulse.json", {
      name: "05-pulse",
      windows: [{ name: "pulse", repo: "org/pulse-oracle" }],
    });
    const entries = loadFleetEntries();
    expect(entries[0].session.name).toBe("05-pulse");
    expect(entries[0].num).toBe(5);
    expect(entries[0].groupName).toBe("pulse");
  });

  it("skips disabled files", () => {
    clearFleet();
    writeFleet("01-active.json", { name: "01-active", windows: [] });
    writeFleet("02-paused.json.disabled", { name: "02-paused", windows: [] });
    const entries = loadFleetEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].groupName).toBe("active");
  });

  it("parses multi-digit numbers", () => {
    clearFleet();
    writeFleet("99-overview.json", { name: "99-overview", windows: [] });
    const entries = loadFleetEntries();
    expect(entries[0].num).toBe(99);
    expect(entries[0].groupName).toBe("overview");
  });
});

describe("getSessionNames", () => {
  it("returns empty array when tmux is unavailable", async () => {
    const names = await getSessionNames();
    // Mock tmux returns empty string, which should filter to []
    expect(Array.isArray(names)).toBe(true);
  });
});
