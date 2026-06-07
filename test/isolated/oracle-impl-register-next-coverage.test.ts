/** Focused isolated coverage for src/commands/plugins/oracle/impl-register.ts. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OracleEntry } from "../../src/sdk";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "maw-oracle-impl-register-next-"));
const TEST_CONFIG_DIR = join(TEST_ROOT, "config");
const TEST_CACHE_DIR = join(TEST_ROOT, "cache");
const TEST_FLEET_DIR = join(TEST_ROOT, "fleet");
const TEST_GHQ_ROOT = join(TEST_ROOT, "ghq");
const REGISTRY_FILE = join(TEST_CACHE_DIR, "oracles.json");
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalCacheDir = process.env.MAW_CACHE_DIR;
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_CACHE_DIR = TEST_CACHE_DIR;

type Session = { name: string; windows: Array<{ name: string; index?: number }> };

let sessions: Session[] | Error = [];
let logs: string[] = [];
const originalLog = console.log;

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  CONFIG_DIR: TEST_CONFIG_DIR,
  FLEET_DIR: TEST_FLEET_DIR,
  listSessions: async () => {
    if (sessions instanceof Error) throw sessions;
    return sessions;
  },
}));

mock.module(import.meta.resolve("../../src/config/ghq-root"), () => ({
  getGhqRoot: () => TEST_GHQ_ROOT,
}));

const register = await import("../../src/commands/plugins/oracle/impl-register.ts?oracle-impl-register-next-coverage");

function oracleEntry(name: string, patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    name,
    local_path: join(TEST_GHQ_ROOT, "github.com", "Soul-Brews-Studio", `${name}-oracle`),
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

function captureLogs() {
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
  mkdirSync(TEST_FLEET_DIR, { recursive: true });
  mkdirSync(join(TEST_GHQ_ROOT, "github.com"), { recursive: true });
  sessions = [];
  logs = [];
  captureLogs();
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalCacheDir === undefined) delete process.env.MAW_CACHE_DIR;
  else process.env.MAW_CACHE_DIR = originalCacheDir;
});

describe("oracle impl-register next coverage", () => {
  test("findInFleet derives org/repo from project_repos for oracle-suffixed entries", () => {
    writeFileSync(
      join(TEST_FLEET_DIR, "repo-backed.json"),
      JSON.stringify({
        windows: [{ name: "repo-backed-oracle" }],
        project_repos: ["Soul-Brews-Studio/repo-backed-oracle"],
        budded_from: "ancestor",
        budded_at: "2026-05-18T00:00:00.000Z",
      }),
      "utf8",
    );

    const found = register.findInFleet("repo-backed", TEST_FLEET_DIR);

    expect(found).toMatchObject({
      source: "fleet",
      entry: {
        org: "Soul-Brews-Studio",
        repo: "repo-backed-oracle",
        name: "repo-backed",
        has_fleet_config: true,
        budded_from: "ancestor",
        budded_at: "2026-05-18T00:00:00.000Z",
      },
    });
  });

  test("findInFleet skips malformed configs, accepts direct window names, and fills defaults", () => {
    writeFileSync(join(TEST_FLEET_DIR, "bad.json"), "{ invalid", "utf8");
    writeFileSync(
      join(TEST_FLEET_DIR, "direct.json"),
      JSON.stringify({
        windows: [{ name: "direct" }],
        project_repos: [],
      }),
      "utf8",
    );

    const found = register.findInFleet("direct", TEST_FLEET_DIR);

    expect(found?.source).toBe("fleet");
    expect(found?.entry).toMatchObject({
      org: "(unknown)",
      repo: "direct-oracle",
      name: "direct",
      has_fleet_config: true,
      budded_from: null,
      budded_at: null,
    });
    expect(register.findInFleet("direct", join(TEST_ROOT, "missing-fleet"))).toBeNull();
  });

  test("findInFleet accepts state-first read dirs and ignores duplicate legacy files", () => {
    const stateFleetDir = join(TEST_ROOT, "state-fleet-register");
    const legacyFleetDir = join(TEST_ROOT, "legacy-fleet-register");
    mkdirSync(stateFleetDir, { recursive: true });
    mkdirSync(legacyFleetDir, { recursive: true });
    writeFileSync(
      join(stateFleetDir, "01-stateful.json"),
      JSON.stringify({
        windows: [{ name: "stateful-oracle" }],
        project_repos: ["StateOrg/stateful-oracle"],
      }),
      "utf8",
    );
    writeFileSync(
      join(legacyFleetDir, "01-stateful.json"),
      JSON.stringify({
        windows: [{ name: "stateful-oracle" }],
        project_repos: ["LegacyOrg/stateful-oracle"],
      }),
      "utf8",
    );

    const found = register.findInFleet("stateful", [stateFleetDir, legacyFleetDir]);

    expect(found).toMatchObject({
      source: "fleet",
      entry: {
        org: "StateOrg",
        repo: "stateful-oracle",
        name: "stateful",
      },
    });
  });

  test("findInFilesystem skips non-directories and finds direct repo names without psi", () => {
    const root = join(TEST_ROOT, "repos-root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.txt"), "not an org directory", "utf8");
    mkdirSync(join(root, "Soul-Brews-Studio", "plain"), { recursive: true });

    const found = register.findInFilesystem("plain", root);

    expect(found?.source).toBe("filesystem");
    expect(found?.entry).toMatchObject({
      org: "Soul-Brews-Studio",
      repo: "plain",
      name: "plain",
      has_psi: false,
      local_path: join(root, "Soul-Brews-Studio", "plain"),
    });
    expect(register.findInFilesystem("plain", join(TEST_ROOT, "missing-root"))).toBeNull();
  });

  test("findInTmux handles direct window names and swallowed session-list failures", async () => {
    sessions = [{ name: "ops", windows: [{ name: "solo", index: 1 }] }];
    await expect(register.findInTmux("solo")).resolves.toMatchObject({
      source: "tmux",
      entry: { name: "solo", repo: "solo-oracle" },
    });

    sessions = new Error("tmux unavailable");
    await expect(register.findInTmux("solo")).resolves.toBeNull();
  });

  test("cmdOracleRegister uses default raw cache I/O and JSON output", async () => {
    await register.cmdOracleRegister(
      "jsony",
      { json: true },
      {
        findInFleetFn: () => null,
        findInTmuxFn: async () => null,
        findInFilesystemFn: () => ({
          source: "filesystem",
          entry: oracleEntry("jsony"),
        }),
      },
    );

    const written = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    expect(written.oracles.map((entry: OracleEntry) => entry.name)).toEqual(["jsony"]);

    const output = JSON.parse(logs.join("\n"));
    expect(output).toMatchObject({
      schema: 1,
      source: "filesystem",
      registered: { name: "jsony", repo: "jsony-oracle" },
    });
  });

  test("raw registry helpers tolerate invalid input and write normalized JSON", () => {
    const file = join(TEST_CONFIG_DIR, "raw-helper.json");
    expect(register.readRawRegistry(file)).toEqual({});

    writeFileSync(file, "{ invalid", "utf8");
    expect(register.readRawRegistry(file)).toEqual({});

    register.writeRawRegistry(file, { oracles: [oracleEntry("helper")] });
    expect(readFileSync(file, "utf8")).toEndWith("\n");
    expect(JSON.parse(readFileSync(file, "utf8")).oracles[0].name).toBe("helper");
  });

  test("cmdOracleRegister rejects duplicate names and missing discovery results", async () => {
    await expect(register.cmdOracleRegister("dupe", {}, {
      readRawCache: () => ({ oracles: [oracleEntry("dupe", { org: "ExistingOrg" })] }),
      writeRawCache: () => { throw new Error("should not write duplicate"); },
    })).rejects.toThrow("already registered (org: ExistingOrg)");

    await expect(register.cmdOracleRegister("missing", {}, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: () => { throw new Error("should not write missing"); },
      findInFleetFn: () => null,
      findInTmuxFn: async () => null,
      findInFilesystemFn: () => null,
    })).rejects.toThrow("not found in fleet, tmux, or filesystem");
  });

  test("cmdOracleRegister prints human output including local path and validates required name", async () => {
    await expect(register.cmdOracleRegister("")).rejects.toThrow("register requires a name");

    let written: Record<string, unknown> | null = null;
    await register.cmdOracleRegister(
      "plain",
      {},
      {
        readRawCache: () => ({ oracles: [] }),
        writeRawCache: data => {
          written = data;
        },
        findInFleetFn: () => null,
        findInTmuxFn: async () => null,
        findInFilesystemFn: () => ({
          source: "filesystem",
          entry: oracleEntry("plain"),
        }),
      },
    );

    expect((written!.oracles as OracleEntry[]).map(entry => entry.name)).toEqual(["plain"]);
    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Registered plain");
    expect(output).toContain("Source:  filesystem");
    expect(output).toContain("Repo:    plain-oracle");
    expect(output).toContain(`Path:    ${oracleEntry("plain").local_path}`);
  });

  test("cmdOracleRegister default discovery falls through to filesystem lookup", async () => {
    mkdirSync(join(TEST_GHQ_ROOT, "github.com", "Soul-Brews-Studio", "disky-oracle", "ψ"), { recursive: true });

    await register.cmdOracleRegister("disky");

    const written = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    expect(written.oracles.map((entry: OracleEntry) => entry.name)).toEqual(["disky"]);
    expect(written.oracles[0]).toMatchObject({
      org: "Soul-Brews-Studio",
      repo: "disky-oracle",
      has_psi: true,
    });

    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Registered disky");
    expect(output).toContain("Source:  filesystem");
  });
});
