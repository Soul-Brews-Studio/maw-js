import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

// Test the core sync logic directly (no ssh/tmux mocking needed)
// We test findParent, findChildren, and the syncDir logic

const TEST_DIR = join(import.meta.dir, ".test-soul-sync");
const CHILD_PSI = join(TEST_DIR, "child-oracle", "ψ");
const PARENT_PSI = join(TEST_DIR, "parent-oracle", "ψ");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });

  // Create child oracle with learnings
  mkdirSync(join(CHILD_PSI, "memory/learnings"), { recursive: true });
  mkdirSync(join(CHILD_PSI, "memory/retrospectives/2026-04"), { recursive: true });
  mkdirSync(join(CHILD_PSI, "memory/traces/2026-04-06"), { recursive: true });

  writeFileSync(join(CHILD_PSI, "memory/learnings/bitkub-api.md"), "# Bitkub API patterns\nlearned things");
  writeFileSync(join(CHILD_PSI, "memory/learnings/tax-calc.md"), "# Tax calculation\nquarterly process");
  writeFileSync(join(CHILD_PSI, "memory/retrospectives/2026-04/06-session.md"), "# Session retro\ngood work");
  writeFileSync(join(CHILD_PSI, "memory/traces/2026-04-06/2134_bitkub.md"), "# Trace: bitkub\nfound things");

  // Create parent oracle with some existing files
  mkdirSync(join(PARENT_PSI, "memory/learnings"), { recursive: true });
  mkdirSync(join(PARENT_PSI, "memory/retrospectives"), { recursive: true });
  mkdirSync(join(PARENT_PSI, "memory/traces"), { recursive: true });

  // Parent already has tax-calc (should NOT be overwritten)
  writeFileSync(join(PARENT_PSI, "memory/learnings/tax-calc.md"), "# PARENT VERSION - DO NOT OVERWRITE");
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("soul-sync", () => {
  beforeEach(setup);
  afterEach(cleanup);

  describe("syncDir (core file copy logic)", () => {
    // Import the syncDir equivalent by testing through the module
    // Since syncDir is not exported, we test through the file system directly
    // using the same logic pattern

    test("copies new files from child to parent", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/learnings");
      const dst = join(PARENT_PSI, "memory/learnings");

      const count = syncDirForTest(src, dst);

      // bitkub-api.md should be copied (new)
      expect(existsSync(join(dst, "bitkub-api.md"))).toBe(true);
      expect(readFileSync(join(dst, "bitkub-api.md"), "utf-8")).toContain("Bitkub API patterns");

      // tax-calc.md should NOT be overwritten (already exists in parent)
      expect(readFileSync(join(dst, "tax-calc.md"), "utf-8")).toBe("# PARENT VERSION - DO NOT OVERWRITE");

      // Only 1 file copied (bitkub-api.md), tax-calc.md was skipped
      expect(count).toBe(1);
    });

    test("creates nested directories as needed", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/retrospectives");
      const dst = join(PARENT_PSI, "memory/retrospectives");

      const count = syncDirForTest(src, dst);

      // Should create 2026-04/ subdir and copy the file
      expect(existsSync(join(dst, "2026-04/06-session.md"))).toBe(true);
      expect(count).toBe(1);
    });

    test("handles missing source dir gracefully", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const count = syncDirForTest("/nonexistent/path", PARENT_PSI);
      expect(count).toBe(0);
    });

    test("syncs traces with nested date dirs", () => {
      const { syncDirForTest } = require("./soul-sync-helpers");
      const src = join(CHILD_PSI, "memory/traces");
      const dst = join(PARENT_PSI, "memory/traces");

      const count = syncDirForTest(src, dst);

      expect(existsSync(join(dst, "2026-04-06/2134_bitkub.md"))).toBe(true);
      expect(count).toBe(1);
    });
  });

  describe("project_repos lookup (cell membrane)", () => {
    test("findProjectsForOracle returns configured project_repos", () => {
      const { findProjectsForOracleForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "08-mawjs", windows: [], project_repos: ["Soul-Brews-Studio/maw-js"] },
        { name: "01-pulse", windows: [] },
      ];
      expect(findProjectsForOracleForTest("mawjs", fleet)).toEqual(["Soul-Brews-Studio/maw-js"]);
      expect(findProjectsForOracleForTest("pulse", fleet)).toEqual([]);
      expect(findProjectsForOracleForTest("missing", fleet)).toEqual([]);
    });

    test("findOracleForProject returns owning oracle name", () => {
      const { findOracleForProjectForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "08-mawjs", windows: [], project_repos: ["Soul-Brews-Studio/maw-js"] },
        { name: "01-pulse", windows: [], project_repos: ["laris-co/floodboy", "laris-co/dustboy"] },
      ];
      expect(findOracleForProjectForTest("Soul-Brews-Studio/maw-js", fleet)).toBe("mawjs");
      expect(findOracleForProjectForTest("laris-co/dustboy", fleet)).toBe("pulse");
      expect(findOracleForProjectForTest("nobody/orphan", fleet)).toBeNull();
    });

    test("project ψ/ syncs into oracle ψ/ across all SYNC_DIRS, new files only", () => {
      // Build a fake project + oracle pair
      const PROJECT_PSI = join(TEST_DIR, "project-repo", "ψ");
      const ORACLE_PSI = join(TEST_DIR, "owner-oracle", "ψ");

      mkdirSync(join(PROJECT_PSI, "memory/learnings"), { recursive: true });
      mkdirSync(join(PROJECT_PSI, "memory/retrospectives/2026-04/07"), { recursive: true });
      mkdirSync(join(PROJECT_PSI, "memory/traces/2026-04-07"), { recursive: true });
      writeFileSync(join(PROJECT_PSI, "memory/learnings/git-is-transport.md"), "# git is the transport");
      writeFileSync(join(PROJECT_PSI, "memory/retrospectives/2026-04/07/17.26_yeast.md"), "# yeast");
      writeFileSync(join(PROJECT_PSI, "memory/traces/2026-04-07/1802_maw-wire.md"), "# trace");

      mkdirSync(join(ORACLE_PSI, "memory/learnings"), { recursive: true });
      // Pre-existing file in oracle that must NOT be overwritten
      writeFileSync(join(ORACLE_PSI, "memory/learnings/git-is-transport.md"), "# ORACLE VERSION");

      const { syncDirForTest } = require("./soul-sync-helpers");
      const SYNC_DIRS = ["memory/learnings", "memory/retrospectives", "memory/traces"];
      let total = 0;
      for (const d of SYNC_DIRS) {
        total += syncDirForTest(join(PROJECT_PSI, d), join(ORACLE_PSI, d));
      }

      // 2 new files copied (retro + trace); learning was pre-existing → skipped
      expect(total).toBe(2);
      expect(existsSync(join(ORACLE_PSI, "memory/retrospectives/2026-04/07/17.26_yeast.md"))).toBe(true);
      expect(existsSync(join(ORACLE_PSI, "memory/traces/2026-04-07/1802_maw-wire.md"))).toBe(true);
      expect(readFileSync(join(ORACLE_PSI, "memory/learnings/git-is-transport.md"), "utf-8")).toBe("# ORACLE VERSION");
    });
  });

  describe("findPeers (flat peer lookup)", () => {
    test("returns empty for oracle without sync_peers", () => {
      const { findPeersForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "01-pulse", windows: [{ name: "pulse-oracle", repo: "laris-co/pulse-oracle" }] },
        { name: "06-floodboy", windows: [{ name: "floodboy-oracle", repo: "laris-co/floodboy-oracle" }] },
      ];
      expect(findPeersForTest("floodboy", fleet)).toEqual([]);
    });

    test("returns configured sync_peers", () => {
      const { findPeersForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "06-floodboy", windows: [], sync_peers: ["pulse", "neo"] },
        { name: "01-pulse", windows: [], sync_peers: ["floodboy", "fireman"] },
      ];
      expect(findPeersForTest("floodboy", fleet)).toEqual(["pulse", "neo"]);
      expect(findPeersForTest("pulse", fleet)).toEqual(["floodboy", "fireman"]);
    });

    test("returns empty for oracle with empty sync_peers", () => {
      const { findPeersForTest } = require("./soul-sync-helpers");
      const fleet = [
        { name: "06-floodboy", windows: [], sync_peers: [] },
      ];
      expect(findPeersForTest("floodboy", fleet)).toEqual([]);
    });
  });
});
