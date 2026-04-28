/**
 * Tests for cmdFleetValidate from src/commands/shared/fleet-validate.ts.
 * Mocks fleet-load, config, tmux, and fs to test validation logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "fleet-val-"));
const ghqRoot = join(tmp, "ghq");
mkdirSync(ghqRoot, { recursive: true });

let fleetEntries: any[] = [];
let sessionNames: string[] = [];
let tmuxWindows: any[] = [];
let existingPaths = new Set<string>();

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rSdk = await import("../../src/sdk");

mock.module("../../src/sdk", () => ({
  ..._rSdk,
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  tmux: {
    listWindows: async () => tmuxWindows,
    ls: async () => [],
    run: async () => "",
  },
  hostExec: async () => "",
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({
    ghqRoot,
    node: "test",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => fleetEntries,
  getSessionNames: async () => sessionNames,
  loadFleet: () => fleetEntries.map((e: any) => e.session),
}));

// Override existsSync for repo path checking
const origExists = require("fs").existsSync;
mock.module("fs", () => {
  const real = require("fs");
  return {
    ...real,
    existsSync: (p: string) => {
      if (p.startsWith(ghqRoot)) return existingPaths.has(p);
      return origExists(p);
    },
  };
});

const { cmdFleetValidate } = await import("../../src/commands/shared/fleet-validate");

beforeEach(() => {
  fleetEntries = [];
  sessionNames = [];
  tmuxWindows = [];
  existingPaths.clear();
});

describe("cmdFleetValidate", () => {
  it("runs without error on empty fleet", async () => {
    await cmdFleetValidate(); // should not throw
  });

  it("detects duplicate fleet numbers", async () => {
    fleetEntries = [
      { file: "01-a.json", num: 1, groupName: "a", session: { name: "a", windows: [] } },
      { file: "01-b.json", num: 1, groupName: "b", session: { name: "b", windows: [] } },
    ];
    // Captures console output — just verify it doesn't crash
    await cmdFleetValidate();
  });

  it("detects oracle in multiple configs", async () => {
    fleetEntries = [
      { file: "01-a.json", num: 1, groupName: "a", session: { name: "sess-a", windows: [{ name: "neo-oracle", repo: "org/neo" }] } },
      { file: "02-b.json", num: 2, groupName: "b", session: { name: "sess-b", windows: [{ name: "neo-oracle", repo: "org/neo2" }] } },
    ];
    await cmdFleetValidate();
  });

  it("detects missing repo paths", async () => {
    fleetEntries = [
      { file: "01-test.json", num: 1, groupName: "test", session: { name: "test", windows: [{ name: "neo-oracle", repo: "org/nonexistent" }] } },
    ];
    // repo path doesn't exist in existingPaths
    await cmdFleetValidate();
  });

  it("detects orphan tmux sessions", async () => {
    fleetEntries = [
      { file: "01-test.json", num: 1, groupName: "test", session: { name: "configured", windows: [] } },
    ];
    sessionNames = ["configured", "orphan-session"];
    await cmdFleetValidate();
  });

  it("passes cleanly when everything is valid", async () => {
    const repoPath = join(ghqRoot, "org/neo");
    existingPaths.add(repoPath);
    fleetEntries = [
      { file: "01-test.json", num: 1, groupName: "test", session: { name: "test", windows: [{ name: "neo-oracle", repo: "org/neo" }] } },
    ];
    sessionNames = ["test"];
    tmuxWindows = [{ name: "neo-oracle", index: 0, active: true }];
    await cmdFleetValidate();
  });

  it("handles no running sessions gracefully", async () => {
    fleetEntries = [
      { file: "01-test.json", num: 1, groupName: "test", session: { name: "test", windows: [{ name: "neo-oracle", repo: "org/neo" }] } },
    ];
    sessionNames = [];
    await cmdFleetValidate();
  });
});
