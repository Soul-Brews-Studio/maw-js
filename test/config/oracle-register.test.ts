/**
 * Tests for findInFleet, findInTmux, findInFilesystem, and cmdOracleRegister
 * from src/commands/plugins/oracle/impl-register.ts.
 * All functions have DI seams — testable with temp dirs and injectable deps.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  findInFleet,
  findInTmux,
  findInFilesystem,
  cmdOracleRegister,
} from "../../src/commands/plugins/oracle/impl-register";
import type { DiscoveredOracle } from "../../src/commands/plugins/oracle/impl-register";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-register-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── findInFleet ─────────────────────────────────────────────────────────────

describe("findInFleet", () => {
  it("finds oracle by name in fleet config windows", () => {
    const fleetDir = join(tmp, "fleet");
    mkdirSync(fleetDir);
    writeFileSync(join(fleetDir, "01-test.json"), JSON.stringify({
      name: "01-test",
      windows: [{ name: "neo-oracle", repo: "org/neo-oracle" }],
      project_repos: ["Soul-Brews-Studio/neo-oracle"],
    }));
    const result = findInFleet("neo", fleetDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("fleet");
    expect(result!.entry.name).toBe("neo");
    expect(result!.entry.org).toBe("Soul-Brews-Studio");
    expect(result!.entry.repo).toBe("neo-oracle");
    expect(result!.entry.has_fleet_config).toBe(true);
  });

  it("finds oracle by exact name (without -oracle suffix)", () => {
    const fleetDir = join(tmp, "fleet");
    mkdirSync(fleetDir);
    writeFileSync(join(fleetDir, "01-test.json"), JSON.stringify({
      name: "01-test",
      windows: [{ name: "mawjs", repo: "org/mawjs" }],
    }));
    const result = findInFleet("mawjs", fleetDir);
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("mawjs");
  });

  it("returns null when oracle not in fleet", () => {
    const fleetDir = join(tmp, "fleet");
    mkdirSync(fleetDir);
    writeFileSync(join(fleetDir, "01-test.json"), JSON.stringify({
      name: "01-test",
      windows: [{ name: "other-oracle", repo: "org/other" }],
    }));
    expect(findInFleet("neo", fleetDir)).toBeNull();
  });

  it("returns null when fleet dir does not exist", () => {
    expect(findInFleet("neo", join(tmp, "nonexistent"))).toBeNull();
  });

  it("skips disabled fleet files", () => {
    const fleetDir = join(tmp, "fleet");
    mkdirSync(fleetDir);
    // .disabled files don't end with .json — filter catches them
    writeFileSync(join(fleetDir, "01-test.json.disabled"), JSON.stringify({
      name: "01-test",
      windows: [{ name: "neo-oracle", repo: "org/neo" }],
    }));
    expect(findInFleet("neo", fleetDir)).toBeNull();
  });

  it("preserves budded_from lineage", () => {
    const fleetDir = join(tmp, "fleet");
    mkdirSync(fleetDir);
    writeFileSync(join(fleetDir, "01-child.json"), JSON.stringify({
      name: "01-child",
      windows: [{ name: "child-oracle" }],
      budded_from: "parent-oracle",
      budded_at: "2026-01-01",
    }));
    const result = findInFleet("child", fleetDir);
    expect(result!.entry.budded_from).toBe("parent-oracle");
    expect(result!.entry.budded_at).toBe("2026-01-01");
  });
});

// ─── findInTmux ──────────────────────────────────────────────────────────────

describe("findInTmux", () => {
  it("finds oracle by window name with -oracle suffix", async () => {
    const mockListSessions = async () => [
      { name: "01-test", windows: [{ index: 0, name: "neo-oracle", active: true }] },
    ];
    const result = await findInTmux("neo", mockListSessions);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("tmux");
    expect(result!.entry.name).toBe("neo");
    expect(result!.entry.repo).toBe("neo-oracle");
  });

  it("finds oracle by exact name", async () => {
    const mockListSessions = async () => [
      { name: "01-test", windows: [{ index: 0, name: "mawjs", active: true }] },
    ];
    const result = await findInTmux("mawjs", mockListSessions);
    expect(result!.entry.name).toBe("mawjs");
  });

  it("returns null when not found", async () => {
    const mockListSessions = async () => [
      { name: "01-test", windows: [{ index: 0, name: "other", active: true }] },
    ];
    expect(await findInTmux("neo", mockListSessions)).toBeNull();
  });

  it("returns null when tmux has no sessions", async () => {
    const mockListSessions = async () => [];
    expect(await findInTmux("neo", mockListSessions)).toBeNull();
  });

  it("handles tmux errors gracefully", async () => {
    const mockListSessions = async () => { throw new Error("tmux not running"); };
    expect(await findInTmux("neo", mockListSessions)).toBeNull();
  });
});

// ─── findInFilesystem ────────────────────────────────────────────────────────

describe("findInFilesystem", () => {
  it("finds oracle repo with -oracle suffix", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "MyOrg", "neo-oracle"), { recursive: true });
    const result = findInFilesystem("neo", ghq);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("filesystem");
    expect(result!.entry.org).toBe("MyOrg");
    expect(result!.entry.repo).toBe("neo-oracle");
    expect(result!.entry.local_path).toBe(join(ghq, "MyOrg", "neo-oracle"));
  });

  it("finds oracle repo by exact name", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "Org", "mawjs"), { recursive: true });
    const result = findInFilesystem("mawjs", ghq);
    expect(result!.entry.repo).toBe("mawjs");
  });

  it("prefers -oracle suffix over exact name", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "Org", "neo-oracle"), { recursive: true });
    mkdirSync(join(ghq, "Org", "neo"), { recursive: true });
    const result = findInFilesystem("neo", ghq);
    expect(result!.entry.repo).toBe("neo-oracle");
  });

  it("detects ψ/ directory", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "Org", "neo-oracle", "ψ"), { recursive: true });
    const result = findInFilesystem("neo", ghq);
    expect(result!.entry.has_psi).toBe(true);
  });

  it("reports no ψ/ when absent", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "Org", "neo-oracle"), { recursive: true });
    const result = findInFilesystem("neo", ghq);
    expect(result!.entry.has_psi).toBe(false);
  });

  it("returns null when not found", () => {
    const ghq = join(tmp, "ghq");
    mkdirSync(join(ghq, "Org", "other-oracle"), { recursive: true });
    expect(findInFilesystem("neo", ghq)).toBeNull();
  });

  it("returns null when ghq root does not exist", () => {
    expect(findInFilesystem("neo", join(tmp, "nonexistent"))).toBeNull();
  });
});

// ─── cmdOracleRegister ───────────────────────────────────────────────────────

describe("cmdOracleRegister", () => {
  it("throws when name is empty", async () => {
    expect(cmdOracleRegister("")).rejects.toThrow("register requires a name");
  });

  it("throws on collision (oracle already registered)", async () => {
    const cache = { oracles: [{ name: "neo", org: "Org" }] };
    expect(cmdOracleRegister("neo", {}, {
      readRawCache: () => cache,
      writeRawCache: () => {},
      findInFleetFn: () => null,
      findInTmuxFn: async () => null,
      findInFilesystemFn: () => null,
    })).rejects.toThrow("already registered");
  });

  it("throws when oracle not found in any source", async () => {
    expect(cmdOracleRegister("ghost", {}, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: () => {},
      findInFleetFn: () => null,
      findInTmuxFn: async () => null,
      findInFilesystemFn: () => null,
    })).rejects.toThrow("not found");
  });

  it("registers oracle from fleet and writes to cache", async () => {
    let written: any = null;
    const discovered: DiscoveredOracle = {
      source: "fleet",
      entry: {
        org: "Org", repo: "neo-oracle", name: "neo",
        local_path: "", has_psi: false, has_fleet_config: true,
        budded_from: null, budded_at: null,
        federation_node: null, detected_at: "2026-01-01",
      },
    };
    await cmdOracleRegister("neo", {}, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: (data) => { written = data; },
      findInFleetFn: () => discovered,
      findInTmuxFn: async () => null,
      findInFilesystemFn: () => null,
    });
    expect(written).not.toBeNull();
    expect(written.oracles).toHaveLength(1);
    expect(written.oracles[0].name).toBe("neo");
  });

  it("falls through fleet → tmux → filesystem", async () => {
    let written: any = null;
    const fsOracle: DiscoveredOracle = {
      source: "filesystem",
      entry: {
        org: "Org", repo: "neo-oracle", name: "neo",
        local_path: "/path", has_psi: true, has_fleet_config: false,
        budded_from: null, budded_at: null,
        federation_node: null, detected_at: "2026-01-01",
      },
    };
    await cmdOracleRegister("neo", {}, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: (data) => { written = data; },
      findInFleetFn: () => null,    // fleet misses
      findInTmuxFn: async () => null, // tmux misses
      findInFilesystemFn: () => fsOracle, // filesystem hits
    });
    expect(written.oracles[0].local_path).toBe("/path");
  });

  it("outputs JSON when opts.json is true", async () => {
    const discovered: DiscoveredOracle = {
      source: "tmux",
      entry: {
        org: "(unregistered)", repo: "neo-oracle", name: "neo",
        local_path: "", has_psi: false, has_fleet_config: false,
        budded_from: null, budded_at: null,
        federation_node: null, detected_at: "2026-01-01",
      },
    };
    // Should not throw
    await cmdOracleRegister("neo", { json: true }, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: () => {},
      findInFleetFn: () => null,
      findInTmuxFn: async () => discovered,
      findInFilesystemFn: () => null,
    });
  });
});
