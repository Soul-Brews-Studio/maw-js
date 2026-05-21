import { beforeEach, describe, expect, mock, test } from "bun:test";

const sharedFleetPath = import.meta.resolve("../../src/commands/shared/fleet");
const fleetInitPath = import.meta.resolve("../../src/commands/plugins/fleet/fleet-init");
const healthPath = import.meta.resolve("../../src/commands/plugins/fleet/fleet-health");
const doctorPath = import.meta.resolve("../../src/commands/shared/fleet-doctor");
const consolidatePath = import.meta.resolve("../../src/commands/plugins/fleet/fleet-consolidate");
const snapshotPath = import.meta.resolve("../../src/core/fleet/snapshot");
const wakeCmdPath = import.meta.resolve("../../src/commands/shared/wake-cmd");

let initCalls: Array<Record<string, unknown>> = [];
let initAgentsCalls: Array<Record<string, unknown>> = [];
let lsCalls = 0;
let renameCalls: Array<Record<string, unknown>> = [];
let renumberCalls = 0;
let validateCalls = 0;
let healthCalls = 0;
let doctorCalls: Array<Record<string, unknown>> = [];
let consolidateCalls: Array<Record<string, unknown>> = [];
let syncConfigsCalls = 0;
let syncWindowsCalls = 0;
let takeSnapshotCalls: string[] = [];
let wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];

let listSnapshotsReturn: Array<Record<string, unknown>> = [];
let loadSnapshotReturn: Record<string, any> | null = null;
let latestSnapshotReturn: Record<string, any> | null = null;
let takeSnapshotReturn = "/tmp/fleet-snapshot.json";
let throwLabel: string | null = null;
let wakeFailures = new Map<string, string>();

mock.module(fleetInitPath, () => ({
  cmdFleetInit: async () => {
    initCalls.push({});
    console.log("fleet init");
  },
  cmdFleetInitAgents: async (opts: Record<string, unknown>) => {
    initAgentsCalls.push(opts);
    console.log("fleet init agents");
  },
}));

mock.module(sharedFleetPath, () => ({
  cmdFleetLs: async () => {
    lsCalls += 1;
    if (throwLabel === "ls") throw new Error("ls exploded");
    console.log("fleet ls");
  },
  cmdFleetRename: async (opts: Record<string, unknown>) => {
    renameCalls.push(opts);
    console.log("fleet rename");
  },
  cmdFleetRenumber: async () => {
    renumberCalls += 1;
    console.log("fleet renumber");
  },
  cmdFleetValidate: async () => {
    validateCalls += 1;
    console.log("fleet validate");
  },
  cmdFleetSyncConfigs: async () => {
    syncConfigsCalls += 1;
    console.log("fleet sync configs");
  },
  cmdFleetSync: async () => {
    syncWindowsCalls += 1;
    console.log("fleet sync windows");
  },
}));

mock.module(healthPath, () => ({
  cmdFleetHealth: async () => {
    healthCalls += 1;
    if (throwLabel === "health") throw new Error("health exploded");
    console.log("fleet health");
  },
}));

mock.module(doctorPath, () => ({
  cmdFleetDoctor: async (opts: Record<string, unknown>) => {
    doctorCalls.push(opts);
    console.log("fleet doctor");
  },
}));

mock.module(consolidatePath, () => ({
  cmdFleetConsolidate: async (opts: Record<string, unknown>) => {
    consolidateCalls.push(opts);
    console.log("fleet consolidate");
  },
}));

mock.module(snapshotPath, () => ({
  listSnapshots: () => listSnapshotsReturn,
  loadSnapshot: (id: string) => (id === "latest" ? latestSnapshotReturn : loadSnapshotReturn),
  latestSnapshot: () => latestSnapshotReturn,
  takeSnapshot: async (trigger: string) => {
    takeSnapshotCalls.push(trigger);
    return takeSnapshotReturn;
  },
}));

mock.module(wakeCmdPath, () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    const failure = wakeFailures.get(oracle);
    if (failure) throw new Error(failure);
  },
}));

const { command, default: handler } = await import("../../src/commands/plugins/fleet/index.ts?fleet-index-coverage");

beforeEach(() => {
  initCalls = [];
  initAgentsCalls = [];
  lsCalls = 0;
  renameCalls = [];
  renumberCalls = 0;
  validateCalls = 0;
  healthCalls = 0;
  doctorCalls = [];
  consolidateCalls = [];
  syncConfigsCalls = 0;
  syncWindowsCalls = 0;
  takeSnapshotCalls = [];
  wakeCalls = [];

  listSnapshotsReturn = [];
  loadSnapshotReturn = null;
  latestSnapshotReturn = null;
  takeSnapshotReturn = "/tmp/fleet-snapshot.json";
  throwLabel = null;
  wakeFailures = new Map<string, string>();
});

function makeSnapshot() {
  return {
    timestamp: "2026-05-18T00:00:00.000Z",
    trigger: "manual",
    sessions: [
      { name: "05-alpha", windows: [{ name: "main" }, { name: "notes" }] },
      { name: "06-beta", windows: [{ name: "main" }] },
    ],
  };
}

describe("fleet plugin index", () => {
  test("exports metadata and defaults to fleet ls while respecting ctx.writer", async () => {
    const writes: string[] = [];

    const result = await handler({
      source: "api",
      args: {},
      writer: (...parts: unknown[]) => writes.push(parts.map(String).join(" ")),
    } as any);

    expect(command).toEqual({
      name: "fleet",
      description: "Manage the persistent fleet registry; use maw ls for currently live sessions.",
    });
    expect(result).toEqual({ ok: true, output: undefined });
    expect(lsCalls).toBe(1);
    expect(writes).toEqual(["fleet ls"]);
  });

  test("routes init, health, doctor alias, consolidate, sync, sync-windows, rename, renumber, and validate branches", async () => {
    await handler({ source: "cli", args: ["init"] } as any);
    await handler({ source: "cli", args: ["init", "--agents", "--dry-run"] } as any);
    await handler({ source: "cli", args: ["health"] } as any);
    await handler({ source: "cli", args: ["dr", "--fix", "--json"] } as any);
    await handler({ source: "cli", args: ["consolidate", "--dry-run", "--remove"] } as any);
    await handler({ source: "cli", args: ["sync"] } as any);
    await handler({ source: "cli", args: ["sync-windows"] } as any);
    await handler({ source: "cli", args: ["rename", "23-old", "23-new", "--dry-run", "--force"] } as any);
    await handler({ source: "cli", args: ["renumber"] } as any);
    await handler({ source: "cli", args: ["validate"] } as any);

    expect(initCalls).toEqual([{}]);
    expect(initAgentsCalls).toEqual([{ dryRun: true }]);
    expect(healthCalls).toBe(1);
    expect(doctorCalls).toEqual([{ fix: true, json: true, reboot: false }]);
    expect(consolidateCalls).toEqual([{ dryRun: true, remove: true }]);
    expect(syncConfigsCalls).toBe(1);
    expect(syncWindowsCalls).toBe(1);
    expect(renameCalls).toEqual([{ oldName: "23-old", newName: "23-new", dryRun: true, force: true }]);
    expect(renumberCalls).toBe(1);
    expect(validateCalls).toBe(1);
  });

  test("handles snapshot listing in empty, json, and formatted modes", async () => {
    let result = await handler({ source: "cli", args: ["snapshots", "list"] } as any);
    expect(result).toEqual({ ok: true, output: "no snapshots yet" });

    listSnapshotsReturn = [
      {
        file: "snap-a.json",
        timestamp: "2026-05-18T00:00:00.000Z",
        trigger: "manual",
        sessionCount: 2,
        windowCount: 3,
      },
    ];
    result = await handler({ source: "cli", args: ["snapshot-ls", "--json"] } as any);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output!)).toEqual({ snapshots: listSnapshotsReturn });

    result = await handler({ source: "cli", args: ["snapshots", "ls"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("📸 1 snapshots");
    expect(result.output).toContain("snap-a");
    expect(result.output).toContain("2 sessions, 3 windows");
  });

  test("handles snapshot show/latest, usage failures, and missing snapshots", async () => {
    latestSnapshotReturn = makeSnapshot();

    let result = await handler({ source: "cli", args: ["snapshots", "show", "latest", "--json"] } as any);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output!)).toEqual(latestSnapshotReturn);

    result = await handler({ source: "cli", args: ["snapshots", "view", "latest"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Snapshot:");
    expect(result.output).toContain("05-alpha");
    expect(result.output).toContain("notes");

    result = await handler({ source: "cli", args: ["snapshots", "bogus"] } as any);
    expect(result).toEqual({
      ok: false,
      error: "usage: maw snapshots [list|show <id>|show latest] [--json]",
    });

    latestSnapshotReturn = null;
    result = await handler({ source: "cli", args: ["snapshots", "show", "latest"] } as any);
    expect(result).toEqual({ ok: false, error: "no snapshot found" });
  });

  test("restores snapshots, including wake-all success and failure reporting", async () => {
    let result = await handler({ source: "cli", args: ["restore"] } as any);
    expect(result).toEqual({ ok: false, error: "no snapshot found" });

    latestSnapshotReturn = makeSnapshot();
    result = await handler({ source: "cli", args: ["restore", "--all"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("05-alpha");
    expect(wakeCalls).toEqual([
      { oracle: "alpha", opts: { attach: false } },
      { oracle: "beta", opts: { attach: false } },
    ]);

    wakeCalls = [];
    latestSnapshotReturn = null;
    loadSnapshotReturn = makeSnapshot();
    wakeFailures.set("beta", "beta failed");
    result = await handler({ source: "cli", args: ["restore", "snap-a", "--all"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("05-alpha");
    expect(result.output).toContain("06-beta");
    expect(result.output).toContain("\u001b[32m✓\u001b[0m 05-alpha");
    expect(result.output).toContain("\u001b[31m✗\u001b[0m 06-beta: beta failed");
    expect(wakeCalls).toEqual([
      { oracle: "alpha", opts: { attach: false } },
      { oracle: "beta", opts: { attach: false } },
    ]);
  });

  test("takes snapshots, reports unknown subcommands, and surfaces thrown errors through catch", async () => {
    let result = await handler({ source: "cli", args: ["snapshot", "nightly"] } as any);
    expect(result).toEqual({
      ok: true,
      output: "\u001b[32m📸\u001b[0m snapshot saved: /tmp/fleet-snapshot.json (trigger: nightly)",
    });
    expect(takeSnapshotCalls).toEqual(["nightly"]);

    result = await handler({ source: "cli", args: ["rename", "only-old"] } as any);
    expect(result).toEqual({
      ok: false,
      error: "usage: maw fleet rename <old-name> <new-name> [--dry-run] [--force]",
    });

    result = await handler({ source: "cli", args: ["mystery"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown fleet subcommand: mystery");
    expect(result.error).toContain("usage: maw fleet <init|ls|rename|renumber|validate|health|doctor|consolidate|sync|sync-windows|snapshots|restore|snapshot>");

    throwLabel = "health";
    result = await handler({ source: "cli", args: ["health"] } as any);
    expect(result).toEqual({ ok: false, error: "health exploded", output: undefined });
  });
});
