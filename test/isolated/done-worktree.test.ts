/**
 * Tests for removeFromFleetConfig from src/commands/plugins/done/done-worktree.ts.
 * Uses mock.module to redirect FLEET_DIR to temp dir.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "done-wt-"));
const fleetDir = join(tmp, "fleet");
mkdirSync(fleetDir, { recursive: true });

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: fleetDir,
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

// sdk re-exports from paths — mock.module paths are relative to the SOURCE file
// that does the import, not relative to the test file
const _rSdk = await import("../../src/sdk");

mock.module("../../src/sdk", () => ({
  ..._rSdk,
  CONFIG_DIR: tmp,
  FLEET_DIR: fleetDir,
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
  hostExec: async () => "",
  tmux: { killWindow: async () => {} },
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({
    ghqRoot: join(tmp, "ghq"),
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

const { removeFromFleetConfig } = await import(
  "../../src/commands/plugins/done/done-worktree"
);

beforeEach(() => {
  for (const f of readdirSync(fleetDir)) {
    rmSync(join(fleetDir, f), { force: true });
  }
});

describe("removeFromFleetConfig", () => {
  it("returns false when fleet dir is empty", () => {
    expect(removeFromFleetConfig("neo-oracle")).toBe(false);
  });

  it("returns false when no matching window", () => {
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      name: "test",
      windows: [{ name: "pulse-oracle", repo: "org/repo" }],
    }));
    expect(removeFromFleetConfig("neo-oracle")).toBe(false);
  });

  it("removes matching window and returns true", () => {
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      name: "test",
      windows: [
        { name: "neo-oracle", repo: "org/neo" },
        { name: "pulse-oracle", repo: "org/pulse" },
      ],
    }));
    expect(removeFromFleetConfig("neo-oracle")).toBe(true);

    const updated = JSON.parse(readFileSync(join(fleetDir, "test.json"), "utf-8"));
    expect(updated.windows).toHaveLength(1);
    expect(updated.windows[0].name).toBe("pulse-oracle");
  });

  it("case-insensitive matching", () => {
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      name: "test",
      windows: [{ name: "Neo-Oracle", repo: "org/neo" }],
    }));
    expect(removeFromFleetConfig("neo-oracle")).toBe(true);
  });

  it("removes from multiple fleet files", () => {
    for (const id of ["a", "b"]) {
      writeFileSync(join(fleetDir, `${id}.json`), JSON.stringify({
        name: id,
        windows: [{ name: "shared-oracle", repo: `org/${id}` }],
      }));
    }
    expect(removeFromFleetConfig("shared-oracle")).toBe(true);

    for (const id of ["a", "b"]) {
      const cfg = JSON.parse(readFileSync(join(fleetDir, `${id}.json`), "utf-8"));
      expect(cfg.windows).toHaveLength(0);
    }
  });

  it("skips non-json files", () => {
    writeFileSync(join(fleetDir, "readme.txt"), "not json");
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      name: "test",
      windows: [{ name: "neo-oracle", repo: "org/neo" }],
    }));
    expect(removeFromFleetConfig("neo-oracle")).toBe(true);
  });

  it("handles config with no windows array", () => {
    writeFileSync(join(fleetDir, "empty.json"), JSON.stringify({ name: "empty" }));
    expect(removeFromFleetConfig("neo-oracle")).toBe(false);
  });

  it("preserves file formatting with trailing newline", () => {
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      name: "test",
      windows: [
        { name: "neo-oracle", repo: "org/neo" },
        { name: "pulse-oracle", repo: "org/pulse" },
      ],
    }));
    removeFromFleetConfig("neo-oracle");
    const raw = readFileSync(join(fleetDir, "test.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
