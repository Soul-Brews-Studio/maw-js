/** Targeted isolated branch coverage for src/commands/plugins/oracle/impl-list.ts. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Session = {
  name: string;
  windows: Array<{ index: number; name: string; active?: boolean }>;
};

type Cache = {
  local_scanned_at: string;
  oracles: any[];
};

type ManifestEntry = {
  name: string;
  repo?: string;
  localPath?: string;
  hasPsi?: boolean;
  hasFleetConfig?: boolean;
  buddedFrom?: string | null;
  buddedAt?: string | null;
  node?: string | null;
  sources: string[];
};

let currentCache: Cache | null = null;
let scanResult: Cache = { local_scanned_at: new Date().toISOString(), oracles: [] };
let stale = false;
let sessions: Session[] | Error = [];
let manifestEntries: ManifestEntry[] = [];
let configValue: any = { node: "fallback-node", agents: {} };
let nicknameByName = new Map<string, string>();
let scanCalls: string[] = [];
let invalidateCalls = 0;
let logs: string[] = [];

const sdkPath = import.meta.resolve("../../src/sdk");
const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load");
const manifestPath = import.meta.resolve("../../src/lib/oracle-manifest");
const nicknamesPath = import.meta.resolve("../../src/core/fleet/nicknames");

mock.module(fleetLoadPath, () => ({
  loadFleetEntries: () => [],
}));

mock.module(sdkPath, () => ({
  FLEET_DIR: "/tmp/maw-oracle-list-second-pass-fleet",
  loadConfig: () => configValue,
  readCache: () => currentCache,
  isCacheStale: () => stale,
  scanAndCache: (scope: string) => {
    scanCalls.push(scope);
    currentCache = scanResult;
    return scanResult;
  },
  listSessions: async () => {
    if (sessions instanceof Error) throw sessions;
    return sessions;
  },
}));

mock.module(manifestPath, () => ({
  loadManifestCached: () => manifestEntries,
  invalidateManifest: () => {
    invalidateCalls += 1;
  },
}));

mock.module(nicknamesPath, () => ({
  resolveNickname: (name: string) => nicknameByName.get(name) ?? null,
}));

const impl = await import("../../src/commands/plugins/oracle/impl-list.ts?oracle-impl-list-second-pass-coverage");

function freshCache(oracles: any[] = []): Cache {
  return {
    local_scanned_at: new Date().toISOString(),
    oracles,
  };
}

function cacheEntry(patch: Record<string, unknown>) {
  return {
    org: "Soul-Brews-Studio",
    repo: "cached-oracle",
    name: "cached",
    local_path: "/tmp/cached-oracle",
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

async function capture(fn: () => Promise<void>) {
  const original = console.log;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs.join("\n");
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  currentCache = freshCache();
  scanResult = freshCache();
  stale = false;
  sessions = [];
  manifestEntries = [];
  configValue = { node: "fallback-node", agents: {} };
  nicknameByName = new Map();
  scanCalls = [];
  invalidateCalls = 0;
  logs = [];
});

describe("oracle impl-list second-pass isolated coverage", () => {
  test("refreshes missing cache with first-scan notice, invalidates manifest, and tolerates tmux failure", async () => {
    currentCache = null;
    scanResult = freshCache();
    sessions = new Error("tmux unavailable");

    const out = await capture(() => impl.cmdOracleList({ stale: false }));
    const plain = stripAnsi(out);

    expect(scanCalls).toEqual(["local"]);
    expect(invalidateCalls).toBe(1);
    expect(plain).toContain("No oracle cache — running first local scan");
    expect(plain).toContain("Oracle Fleet  (0 awake / 0 total)");
    expect(plain).toContain("No oracles found. Run maw oracle scan to refresh.");
  });

  test("does not print first-scan notice for json refresh and emits awake tmux-only rows", async () => {
    currentCache = null;
    scanResult = freshCache();
    sessions = [
      {
        name: "ops",
        windows: [
          { index: 0, name: "loose-oracle" },
          { index: 1, name: "loose-oracle" },
          { index: 2, name: "notes" },
        ],
      },
    ];

    const out = await capture(() => impl.cmdOracleList({ json: true }));
    const parsed = JSON.parse(out);

    expect(out).not.toContain("No oracle cache");
    expect(scanCalls).toEqual(["local"]);
    expect(parsed.total).toBe(1);
    expect(parsed.awake).toBe(1);
    expect(parsed.oracles[0]).toMatchObject({
      org: "(unregistered)",
      repo: "loose-oracle",
      name: "loose",
      local_path: "",
      federation_node: "fallback-node",
      awake: true,
      session: "ops",
      sources: ["tmux"],
    });
  });

  test("merges cached manifest entries, manifest node fallback, repo-without-org, and nicknames into json", async () => {
    currentCache = freshCache([
      cacheEntry({ name: "cached", federation_node: null }),
      cacheEntry({ name: "kept-node", federation_node: "cache-node" }),
    ]);
    manifestEntries = [
      { name: "cached", node: "manifest-node", sources: ["oracles-json", "agent"] },
      { name: "kept-node", node: "manifest-node", sources: ["oracles-json", "agent"] },
      { name: "solo", repo: "solo-custom", localPath: "/tmp/solo", hasPsi: true, sources: ["session"] },
    ];
    configValue = { node: "fallback-node", agents: { solo: "agent-node" } };
    nicknameByName.set("solo", "Solo Nick");

    const out = await capture(() => impl.cmdOracleList({ json: true, stale: true }));
    const parsed = JSON.parse(out);

    const cached = parsed.oracles.find((o: any) => o.name === "cached");
    const kept = parsed.oracles.find((o: any) => o.name === "kept-node");
    const solo = parsed.oracles.find((o: any) => o.name === "solo");

    expect(cached.federation_node).toBe("manifest-node");
    expect(kept.federation_node).toBe("cache-node");
    expect(solo).toMatchObject({
      org: "(unregistered)",
      repo: "solo-custom",
      local_path: "/tmp/solo",
      has_psi: true,
      has_fleet_config: false,
      nickname: "Solo Nick",
      sources: ["session"],
    });
    expect(solo.lineage).toMatchObject({
      hasPsi: true,
      hasFleetConfig: false,
      inAgents: true,
      federationNode: "agent-node",
    });
  });

  test("covers formatted empty-state branches for awake, org, and generic filters", async () => {
    currentCache = freshCache();

    const awakeOut = stripAnsi(await capture(() => impl.cmdOracleList({ awake: true, stale: true })));
    expect(awakeOut).toContain("No awake oracles.");

    const orgOut = stripAnsi(await capture(() => impl.cmdOracleList({ org: "MissingOrg", stale: true })));
    expect(orgOut).toContain("No oracles found in org 'MissingOrg'.");

    const genericOut = stripAnsi(await capture(() => impl.cmdOracleList({ stale: true })));
    expect(genericOut).toContain("No oracles found. Run maw oracle scan to refresh.");
  });

  test("filters non-empty rows by awake and org in one json listing", async () => {
    currentCache = freshCache();
    manifestEntries = [
      { name: "awake", repo: "Alpha/awake-oracle", hasFleetConfig: true, sources: ["fleet"] },
      { name: "sleepy", repo: "Alpha/sleepy-oracle", hasFleetConfig: true, sources: ["fleet"] },
      { name: "other", repo: "Beta/other-oracle", hasFleetConfig: true, sources: ["fleet"] },
    ];
    sessions = [{ name: "live", windows: [{ index: 0, name: "awake-oracle" }, { index: 1, name: "other-oracle" }] }];

    const out = await capture(() => impl.cmdOracleList({ awake: true, org: "Alpha", json: true, stale: true }));
    const parsed = JSON.parse(out);

    expect(parsed.total).toBe(1);
    expect(parsed.awake).toBe(1);
    expect(parsed.oracles.map((oracle: any) => oracle.name)).toEqual(["awake"]);
  });

  test("sorts grouped formatted rows by org, awake state, and name while showing paths", async () => {
    currentCache = freshCache();
    manifestEntries = [
      { name: "sleepy", repo: "Zed/sleepy-oracle", hasFleetConfig: true, sources: ["fleet"] },
      { name: "bravo", repo: "Alpha/bravo-oracle", hasFleetConfig: true, sources: ["fleet"] },
      { name: "alpha", repo: "Alpha/alpha-oracle", localPath: "/tmp/alpha", hasPsi: true, sources: ["oracles-json"] },
      { name: "awake", repo: "Alpha/awake-oracle", hasFleetConfig: true, sources: ["fleet"] },
      { name: "mystery", repo: "Alpha/mystery-oracle", sources: ["session"] },
    ];
    sessions = [{ name: "live", windows: [{ index: 0, name: "awake-oracle" }] }];

    const plain = stripAnsi(await capture(() => impl.cmdOracleList({ stale: true, path: true })));

    expect(plain).toContain("Oracle Fleet  (1 awake / 5 total)");
    expect(plain).toContain("Alpha (4):");
    expect(plain).toContain("Zed (1):");
    expect(plain.indexOf("Alpha (4):")).toBeLessThan(plain.indexOf("Zed (1):"));
    expect(plain.indexOf("fleet+awake  awake")).toBeLessThan(plain.indexOf("fs           alpha"));
    expect(plain.indexOf("fs           alpha")).toBeLessThan(plain.indexOf("fleet        bravo"));
    expect(plain).toContain("fs (?)       mystery");
    expect(plain).toContain("uncertain");
    expect(plain).toContain("/tmp/alpha");
    expect(plain).toContain("not cloned");
  });
});
