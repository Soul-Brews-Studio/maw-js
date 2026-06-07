import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/absorb");
const archiveImplPath = join(ROOT, "src/vendor/mpr-plugins/archive/impl.ts");
const soulResolvePath = join(ROOT, "src/vendor/mpr-plugins/soul-sync/resolve.ts");
const syncHelpersPath = join(ROOT, "src/vendor/mpr-plugins/soul-sync/sync-helpers.ts");

type FleetEntry = {
  file: string;
  path: string;
  groupName: string;
  session: { name: string; windows: Array<{ name: string; repo?: string }> };
};

let fleetEntries: FleetEntry[];
let hostExecCalls: string[];
let archiveCalls: Array<{ name: string; opts: Record<string, unknown> }>;
let syncCalls: Array<{ donorPath: string; receiverPath: string; donorName: string; receiverName: string }>;
let resolvePaths: Record<string, string | null>;
let ghqRoot: string;
let syncResult: { total: number; synced: Record<string, number> };

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
  },
  getGhqRoot: () => ghqRoot,
  loadFleetEntries: () => fleetEntries,
}));

mock.module(archiveImplPath, () => ({
  cmdArchive: async (name: string, opts: Record<string, unknown>) => {
    archiveCalls.push({ name, opts });
    if (!(globalThis as any).__archiveStandaloneActive) return;

    const { existsSync, renameSync } = await import("node:fs");
    const { basename, join } = await import("node:path");
    const sdk = await import("maw-js/sdk");
    const entries = sdk.loadFleetEntries();
    const entry = entries.find((row: FleetEntry) =>
      row.groupName === name
      || row.session?.name === name
      || row.session?.windows?.some((window) => window.name === name || window.name === `${name}-oracle`),
    );
    if (!entry) throw new Error(`oracle '${name}' not found in fleet config`);

    const repo = entry.session.windows.find((window: { repo?: string }) => window.repo)?.repo;
    console.log(`Archiving ${name}`);
    const dryRun = Boolean(opts?.dryRun);
    for (const peer of entry.session.sync_peers ?? []) {
      console.log(`[dry-run] would soul-sync to ${peer}`);
    }
    const disabled = `${entry.path}.disabled`;
    console.log(`${dryRun ? "[dry-run] would disable" : "fleet config disabled"}: ${basename(entry.path)}${dryRun ? ` → ${basename(disabled)}` : ".disabled"}`);
    if (repo) {
      const command = `gh repo archive ${repo}${dryRun ? "" : " --yes"}`;
      console.log(`${dryRun ? "[dry-run] would archive" : "GitHub repo archived"}: ${dryRun ? command : repo}`);
      if (!dryRun) await sdk.hostExec(command);
    }
    if (!dryRun && existsSync(entry.path)) renameSync(entry.path, disabled);
  },
  fleetConfigFilePath: (entry: FleetEntry) => entry.path,
}));

mock.module(soulResolvePath, () => ({
  resolveOraclePath: async (name: string) => resolvePaths[name] ?? null,
}));

mock.module(syncHelpersPath, () => ({
  syncOracleVaults: (donorPath: string, receiverPath: string, donorName: string, receiverName: string) => {
    syncCalls.push({ donorPath, receiverPath, donorName, receiverName });
    return syncResult;
  },
}));


function entry(name: string, repo?: string): FleetEntry {
  return {
    file: `${name}.json`,
    path: `/fleet/${name}.json`,
    groupName: name,
    session: { name: `101-${name}`, windows: [{ name: `${name}-oracle`, repo }] },
  };
}

function loadAbsorbPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadAbsorbPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

const { findAbsorbFleetEntry } = await import("../../src/vendor/mpr-plugins/absorb/impl.ts?plugin-absorb-standalone");

beforeEach(() => {
  fleetEntries = [entry("donor", "Org/donor-oracle"), entry("receiver", "Org/receiver-oracle")];
  hostExecCalls = [];
  archiveCalls = [];
  syncCalls = [];
  resolvePaths = { donor: "/repos/donor-oracle", receiver: "/repos/receiver-oracle" };
  ghqRoot = "/ghq";
  syncResult = { total: 2, synced: { "/repos/receiver-oracle/ψ/memory": 2 } };
  delete process.env.TMUX;
});

describe("absorb plugin standalone boundary (#2221)", () => {
  test("plugin sources stay off direct core/shared/lib/config imports", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "absorb",
      files: ["index.ts", "impl.ts"],
      allowRelative: ["../archive/impl", "../soul-sync/resolve", "../soul-sync/sync-helpers"],
    }).map((record) => record.spec);

    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk", "../archive/impl", "../soul-sync/resolve", "../soul-sync/sync-helpers"]));
  });

  test("plugin loads from manifest and reports help without side effects", async () => {
    const plugin = loadAbsorbPlugin();
    expect(plugin.manifest.name).toBe("absorb");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("absorb v1.0.0");
    expect(result.output).toContain("maw absorb");
    expect(archiveCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test("findAbsorbFleetEntry matches session prefixes, oracle suffixes, and repo names", () => {
    expect(findAbsorbFleetEntry(fleetEntries, "101-donor")?.file).toBe("donor.json");
    expect(findAbsorbFleetEntry(fleetEntries, "donor-oracle")?.file).toBe("donor.json");
    expect(findAbsorbFleetEntry(fleetEntries, "receiver")?.file).toBe("receiver.json");
  });

  test("dry-run previews sync/archive/switch without side effects", async () => {
    const { result, output } = await invokeCli(["donor", "--into", "receiver", "--dry-run"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("Absorbing donor -> receiver");
    expect(output).toContain("[dry-run] would sync psi memory");
    expect(output).toContain("[dry-run] would archive donor via: maw archive donor");
    expect(output).toContain("[dry-run] would switch client: tmux switch-client -t '101-receiver'");
    expect(syncCalls).toEqual([]);
    expect(archiveCalls).toEqual([]);
    expect(hostExecCalls).toEqual([]);
  });

  test("non-dry run syncs, archives, and switches when inside tmux", async () => {
    process.env.TMUX = "/tmp/tmux";

    const { result, output } = await invokeCli(["donor", "--into", "receiver"]);

    expect(result.ok).toBe(true);
    expect(syncCalls).toEqual([{ donorPath: "/repos/donor-oracle", receiverPath: "/repos/receiver-oracle", donorName: "donor", receiverName: "receiver" }]);
    expect(archiveCalls).toEqual([{ name: "donor", opts: { dryRun: false } }]);
    expect(hostExecCalls).toEqual(["tmux switch-client -t '101-receiver'"]);
    expect(output).toContain("psi memory sync complete: 2 memory");
    expect(output).toContain("donor absorbed into receiver; donor archive attempted");
  });

  test("falls back to ghq repo path when resolver misses", async () => {
    resolvePaths = {};
    ghqRoot = join(ROOT, "tmp", "absorb-ghq");
    mkdirSync(join(ghqRoot, "github.com", "Org", "donor-oracle"), { recursive: true });
    mkdirSync(join(ghqRoot, "github.com", "Org", "receiver-oracle"), { recursive: true });

    const { result } = await invokeCli(["donor", "--into", "receiver"]);

    expect(result.ok).toBe(true);
    expect(syncCalls[0]).toMatchObject({
      donorPath: join(ghqRoot, "github.com", "Org", "donor-oracle"),
      receiverPath: join(ghqRoot, "github.com", "Org", "receiver-oracle"),
    });
  });

  test("validates missing args, unknown fleet entries, and same donor/receiver", async () => {
    expect((await invokeCli(["donor"])).result).toMatchObject({ ok: false, error: expect.stringContaining("usage: maw absorb") });
    expect((await invokeCli(["ghost", "--into", "receiver"])).result).toMatchObject({ ok: false, error: expect.stringContaining("donor oracle 'ghost' not found") });
    expect((await invokeCli(["donor", "--into", "donor"])).result).toMatchObject({ ok: false, error: expect.stringContaining("donor and receiver must be different") });
  });
});
