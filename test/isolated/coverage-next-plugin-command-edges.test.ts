import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import type { FleetEntry, FleetSession } from "../../src/commands/shared/fleet-load";
import {
  cmdFleetRename,
  cmdFleetRenumber,
  fleetManageDeps,
  renderFleetLs,
  type FleetManageDeps,
} from "../../src/commands/shared/fleet-manage";
import * as prune from "../../src/commands/plugins/oracle/impl-prune";

const srcRoot = join(import.meta.dir, "../..");

let sharedFleetCalls: Array<{ name: string; args: unknown[] }> = [];
let snapshots: any[] = [];
let snapshotById: Record<string, any | null> = {};
let latest: any | null = null;
let wakeCalls: string[] = [];

mock.module(join(srcRoot, "src/commands/shared/fleet"), () => ({
  cmdFleetLs: async () => { sharedFleetCalls.push({ name: "ls", args: [] }); console.log("fleet listed"); },
  cmdFleetRenumber: async () => { sharedFleetCalls.push({ name: "renumber", args: [] }); },
  cmdFleetRename: async (opts: unknown) => { sharedFleetCalls.push({ name: "rename", args: [opts] }); },
  cmdFleetValidate: async () => { sharedFleetCalls.push({ name: "validate", args: [] }); },
  cmdFleetSyncConfigs: async () => { sharedFleetCalls.push({ name: "sync-configs", args: [] }); },
  cmdFleetSync: async () => { sharedFleetCalls.push({ name: "sync", args: [] }); },
}));
mock.module(join(srcRoot, "src/core/fleet/snapshot"), () => ({
  listSnapshots: () => snapshots,
  loadSnapshot: (id: string) => snapshotById[id] ?? null,
  latestSnapshot: () => latest,
  takeSnapshot: async (trigger: string) => {
    sharedFleetCalls.push({ name: "snapshot", args: [trigger] });
    return `/snapshots/${trigger}.json`;
  },
}));
mock.module(join(srcRoot, "src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (oracle: string) => {
    wakeCalls.push(oracle);
    if (oracle === "fail-oracle") throw new Error("wake failed");
  },
}));

const fleetHandler = (await import("../../src/commands/plugins/fleet/index.ts?coverage-next-plugin-command-edges")).default;

function session(name: string, windows: Array<{ name: string; repo?: string }> = []): FleetSession {
  return {
    name,
    windows: windows.map((w) => ({ name: w.name, repo: w.repo ?? "Soul-Brews-Studio/example" })),
  };
}

function entry(file: string, num: number, groupName: string, fleetSession: FleetSession): FleetEntry {
  return { file, num, groupName, session: fleetSession };
}

function makeDeps(entries: FleetEntry[], options: {
  exists?: (path: string) => boolean;
  running?: string[];
} = {}) {
  const logs: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const unlinks: string[] = [];
  const tmuxRuns: string[][] = [];
  const deps = fleetManageDeps({
    loadFleetEntries: () => entries,
    getSessionNames: async () => options.running ?? [],
    readdirSync: () => [],
    fleetDir: "/fleet",
    writeFile: async (path: string, contents: string) => { writes.push({ path, contents }); },
    renameSync: (from: string, to: string) => { renames.push({ from, to }); },
    existsSync: (path: string) => options.exists?.(path) ?? true,
    unlinkSync: (path: string) => { unlinks.push(path); },
    join: (...parts: string[]) => parts.join("/"),
    tmuxRun: async (...args: string[]) => {
      tmuxRuns.push(args);
      if (args[2] === "02-gamma") throw new Error("tmux failed");
      return "";
    },
    log: (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); },
  } satisfies Partial<FleetManageDeps>);
  return { deps, logs, writes, renames, unlinks, tmuxRuns };
}

beforeEach(() => {
  sharedFleetCalls = [];
  snapshots = [];
  snapshotById = {};
  latest = null;
  wakeCalls = [];
});

describe("coverage-next plugin command edges", () => {
  test("fleet handler reports usage errors, snapshot lists, snapshot views, restores, and delegated calls", async () => {
    let result = await fleetHandler({ source: "cli", args: ["rename", "only-old"] } as any);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("usage: maw fleet rename");

    result = await fleetHandler({ source: "cli", args: ["ls"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet listed");
    expect(sharedFleetCalls).toContainEqual({ name: "ls", args: [] });

    snapshots = [{
      file: "snap-a.json",
      timestamp: "2026-05-18T01:02:03.000Z",
      trigger: "manual",
      sessionCount: 1,
      windowCount: 2,
    }];
    result = await fleetHandler({ source: "cli", args: ["snapshots", "list", "--json"] } as any);
    expect(JSON.parse(result.output!).snapshots).toHaveLength(1);

    latest = {
      timestamp: "2026-05-18T01:02:03.000Z",
      trigger: "manual",
      sessions: [{ name: "01-lyra", windows: [{ name: "lyra-oracle" }] }],
    };
    result = await fleetHandler({ source: "cli", args: ["snapshots", "show", "latest"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("01-lyra");

    result = await fleetHandler({ source: "cli", args: ["restore", "--all"] } as any);
    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual(["lyra"]);

    wakeCalls = [];
    latest = null;
    snapshotById["snap-a"] = {
      timestamp: "2026-05-18T01:02:03.000Z",
      trigger: "manual",
      sessions: [
        { name: "01-lyra", windows: [{ name: "lyra-oracle" }] },
        { name: "02-fail-oracle", windows: [{ name: "fail-oracle" }] },
      ],
    };
    result = await fleetHandler({ source: "cli", args: ["restore", "snap-a", "--all"] } as any);
    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual(["lyra", "fail-oracle"]);
    expect(result.output).toContain("wake failed");

    result = await fleetHandler({ source: "cli", args: ["snapshot", "manual-test"] } as any);
    expect(result.output).toContain("/snapshots/manual-test.json");

    result = await fleetHandler({ source: "cli", args: ["unknown"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown fleet subcommand");
  });

  test("fleet manage validates names, detects conflicts, dry-runs, and renumbers with tmux failure logging", async () => {
    expect(renderFleetLs([
      entry("01-alpha.json", 1, "alpha", session("01-alpha", [{ name: "alpha-oracle" }])),
      entry("01-gamma.json", 1, "gamma", session("01-gamma")),
      entry("bad.json", 3, "bad", { windows: "nope" } as any),
    ], 1, ["01-alpha"]).join("\n")).toContain("CONFLICT");

    const target = entry("02-alpha.json", 2, "alpha", session("02-alpha"));
    await expect(cmdFleetRename({ oldName: "../alpha", newName: "ok" }, makeDeps([target]).deps))
      .rejects.toThrow(/invalid old fleet name/);
    await expect(cmdFleetRename({ oldName: "missing", newName: "ok" }, makeDeps([target]).deps))
      .rejects.toThrow(/fleet not found/);

    const dry = makeDeps([target], { exists: (path) => !path.endsWith("02-renamed.json"), running: ["02-alpha"] });
    await cmdFleetRename({ oldName: "02-alpha", newName: "02-renamed", dryRun: true }, dry.deps);
    expect(dry.writes).toEqual([]);
    expect(dry.logs.join("\n")).toContain("dry-run: would write 02-renamed.json");

    const renumber = makeDeps([
      entry("02-alpha.json", 2, "alpha", session("02-alpha")),
      entry("02-gamma.json", 2, "gamma", session("02-gamma")),
      entry("99-overview.json", 99, "overview", session("99-overview")),
    ], { running: ["02-alpha", "02-gamma"] });
    await cmdFleetRenumber(renumber.deps);
    expect(renumber.writes.map((w) => w.path)).toEqual(["/fleet/.tmp-01-alpha.json"]);
    expect(renumber.tmuxRuns).toEqual([["rename-session", "-t", "02-alpha", "01-alpha"]]);
    expect(renumber.logs.join("\n")).toContain("02-gamma.json");
    expect(renumber.logs.join("\n")).toContain("(unchanged)");
  });

  test("oracle prune default branch and force path retire candidates into cache", async () => {
    const raw: Record<string, unknown> = {
      oracles: [
        {
          org: "Soul-Brews-Studio",
          repo: "ghost-oracle",
          name: "ghost",
          local_path: "",
          has_psi: false,
          has_fleet_config: false,
          budded_from: null,
          budded_at: null,
          federation_node: null,
          detected_at: "2026-05-18T00:00:00.000Z",
        },
      ],
      retired: [],
    };
    let written: Record<string, unknown> | null = null;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
    try {
      const candidates = await prune.runPrune({}, {
        listAwake: async () => new Set<string>(),
        readRawCache: () => raw,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].reasons).toEqual(["empty lineage", "not cloned", "no tmux", "no federation"]);

      await prune.cmdOraclePrune({ force: true }, {
        listAwake: async () => new Set<string>(),
        readRawCache: () => raw,
        writeRawCache: (data) => { written = data; },
        promptConfirm: async () => true,
      });
    } finally {
      console.log = originalLog;
    }

    expect((written!.oracles as unknown[])).toEqual([]);
    expect((written!.retired as Array<{ name: string }>)[0].name).toBe("ghost");
    expect(logs.join("\n")).toContain("Retired 1 oracle(s)");
  });
});
