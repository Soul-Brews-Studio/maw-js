import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sdkPath = import.meta.resolve("../../src/sdk");
const sdkIndexPath = import.meta.resolve("../../src/sdk/index");
const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load");
const ghqRootPath = import.meta.resolve("../../src/config/ghq-root");

type FleetEntry = {
  num: number;
  file: string;
  session: { name: string; windows: Array<{ name: string; repo?: string }>; sync_peers?: string[]; budded_from?: string };
};

let fleetDir = "";
let ghqRoot = "";
let entries: FleetEntry[] = [];
let sessions: Array<{ name: string }> = [];
let gitDates = new Map<string, string | Error>();

const originalConfigDir = process.env.MAW_CONFIG_DIR;
const stableConfigDir = mkdtempSync(join(tmpdir(), "maw-fleet-health-config-"));
process.env.MAW_CONFIG_DIR = stableConfigDir;
fleetDir = join(stableConfigDir, "fleet");

const sdkMock = () => ({
  get FLEET_DIR() { return fleetDir; },
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    const repo = cmd.match(/git -C '([^']+)'/)?.[1] ?? "";
    const value = gitDates.get(repo);
    if (value instanceof Error) throw value;
    return value ?? "";
  },
});
mock.module(sdkPath, sdkMock);
mock.module(sdkIndexPath, sdkMock);
mock.module(fleetLoadPath, () => ({
  loadFleetEntries: () => entries,
  loadDisabledFleetEntries: () => readdirSync(fleetDir)
    .filter((file) => file.endsWith(".disabled"))
    .sort()
    .map((file) => {
      const path = join(fleetDir, file);
      const activeName = file.replace(/\.disabled$/i, "");
      const match = activeName.match(/^(\d+)-(.+)\.json$/);
      const base = {
        file,
        path,
        num: match ? parseInt(match[1], 10) : 0,
        groupName: match ? match[2] : activeName.replace(/\.json$/i, ""),
      };
      try {
        return { ...base, session: JSON.parse(readFileSync(path, "utf-8")) };
      } catch (error) {
        return { ...base, error };
      }
    }),
}));
mock.module(ghqRootPath, () => ({
  getGhqRoot: () => ghqRoot,
}));

const { cmdFleetHealth } = await import("../../src/commands/plugins/fleet/fleet-health.ts?fleet-health-coverage");

const capture = async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await cmdFleetHealth();
    return logs.join("\n");
  } finally {
    console.log = origLog;
  }
};

describe("fleet health command coverage", () => {
  let dir: string;
  const now = Date.parse("2026-05-18T12:00:00.000Z");
  const originalDateNow = Date.now;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-fleet-health-"));
    rmSync(fleetDir, { recursive: true, force: true });
    ghqRoot = join(dir, "ghq");
    mkdirSync(fleetDir, { recursive: true });
    mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "awake-oracle"), { recursive: true });
    mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "sleepy-oracle"), { recursive: true });
    mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "dormant-oracle"), { recursive: true });
    mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "disabled-oracle"), { recursive: true });
    Date.now = () => now;
    sessions = [{ name: "01-awake" }, { name: "zombie" }];
    entries = [
      { num: 1, file: "01-awake.json", session: { name: "01-awake", windows: [{ name: "awake-oracle", repo: "Soul-Brews-Studio/awake-oracle" }], sync_peers: ["m5"] } },
      { num: 2, file: "02-sleepy.json", session: { name: "02-sleepy", windows: [{ name: "sleepy-oracle", repo: "Soul-Brews-Studio/sleepy-oracle" }], sync_peers: [] } },
      { num: 3, file: "03-dormant.json", session: { name: "03-dormant", windows: [{ name: "dormant-oracle", repo: "Soul-Brews-Studio/dormant-oracle" }], sync_peers: [], budded_from: "root" } },
      { num: 4, file: "04-zombie.json", session: { name: "zombie", windows: [{ name: "zombie-oracle", repo: "Soul-Brews-Studio/zombie-oracle" }], sync_peers: [] } },
      { num: 5, file: "05-norepo.json", session: { name: "05-norepo", windows: [{ name: "norepo-oracle" }], sync_peers: ["m6"] } },
    ];
    gitDates = new Map([
      [join(ghqRoot, "github.com", "Soul-Brews-Studio", "awake-oracle"), "2026-05-18T01:00:00.000Z"],
      [join(ghqRoot, "github.com", "Soul-Brews-Studio", "sleepy-oracle"), "2026-04-01T01:00:00.000Z"],
      [join(ghqRoot, "github.com", "Soul-Brews-Studio", "dormant-oracle"), "2026-01-01T01:00:00.000Z"],
      [join(ghqRoot, "github.com", "Soul-Brews-Studio", "zombie-oracle"), "2026-04-20T01:00:00.000Z"],
    ]);
  });

  afterEach(() => {
    Date.now = originalDateNow;
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
    else process.env.MAW_CONFIG_DIR = originalConfigDir;
    rmSync(stableConfigDir, { recursive: true, force: true });
  });

  test("renders awake/sleep/dormant/island/zombie/budded rows and summary warnings", async () => {
    const out = await capture();

    expect(out).toContain("🔬 Fleet Health");
    expect(out).toContain("awake");
    expect(out).toContain("today");
    expect(out).toContain("sleepy");
    expect(out).toContain("sleepy island");
    expect(out).toContain("dormant island bud<-root");
    expect(out).toContain("island zombie?");
    expect(out).toContain("5 active | 2 awake | 0 disabled | 1 dormant | 3 islands | 1 zombies");
    expect(out).toContain("inactive >90d");
    expect(out).toContain("knowledge trapped");
    expect(out).toContain("awake but inactive >14d");
  });

  test("renders disabled oracle details, malformed disabled fallback, and unknown git age", async () => {
    gitDates.set(join(ghqRoot, "github.com", "Soul-Brews-Studio", "sleepy-oracle"), new Error("git failed"));
    writeFileSync(join(fleetDir, "09-disabled.json.disabled"), JSON.stringify({ windows: [{ repo: "Soul-Brews-Studio/disabled-oracle" }], sync_peers: ["m5"] }), "utf-8");
    writeFileSync(join(fleetDir, "10-bad.json.disabled"), "{bad-json", "utf-8");

    const out = await capture();

    expect(out).toContain("sleepy");
    expect(out).toContain("? ");
    expect(out).toContain("── Disabled (2) ──");
    expect(out).toContain("disabled");
    expect(out).toContain("repo:yes");
    expect(out).toContain("peers:1");
    expect(out).toContain("✕ bad");
    expect(out).toContain("5 active | 2 awake | 2 disabled");
  });

  test("handles an empty fleet without crashing", async () => {
    entries = [];
    sessions = [];

    const out = await capture();

    expect(out).toContain("Oracle");
    expect(out).toContain("0 active | 0 awake | 0 disabled | 0 dormant | 0 islands | 0 zombies");
  });
});
