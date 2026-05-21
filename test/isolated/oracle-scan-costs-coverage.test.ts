/** Targeted isolated coverage for oracle scan and costs plugin handlers. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type OracleEntry = {
  org: string;
  repo: string;
  name: string;
  local_path: string;
  has_psi: boolean;
};

type OracleCache = {
  oracles: OracleEntry[];
};

const sdkPath = import.meta.resolve("../../src/sdk");
const implListPath = import.meta.resolve("../../src/commands/plugins/oracle/impl-list");
const verbosityPath = import.meta.resolve("../../src/cli/verbosity");
const registryTypesPath = import.meta.resolve("../../src/core/fleet/registry-oracle-types");
const costsImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/costs/impl");

let previousCache: OracleCache | null = null;
let localCache: OracleCache = { oracles: [] };
let remoteEntries: OracleEntry[] = [];
let fullCache: OracleCache = { oracles: [] };
let quietMode = false;
let scanAndCacheCalls: Array<{ scope: string; loud: boolean }> = [];
let scanRemoteCalls: Array<{ scope: unknown; loud: boolean }> = [];
let scanFullCalls: Array<{ scope: unknown; loud: boolean }> = [];
let listCalls: unknown[] = [];

let parseInputs: string[][] = [];
let parseReturn: Record<string, unknown> = {};
let costsCalls = 0;
let dailyCalls: Array<{ days: number; json: boolean }> = [];
let cmdCostsError: Error | null = null;
let cmdCostsDailyError: Error | null = null;

const originalLog = console.log;
const originalError = console.error;

mock.module(sdkPath, () => ({
  readCache: () => previousCache,
  scanAndCache: (scope: string, loud: boolean) => {
    scanAndCacheCalls.push({ scope, loud });
    return localCache;
  },
  scanRemote: async (scope: unknown, loud: boolean) => {
    scanRemoteCalls.push({ scope, loud });
    return remoteEntries;
  },
  scanFull: async (scope: unknown, loud: boolean) => {
    scanFullCalls.push({ scope, loud });
    return fullCache;
  },
}));

mock.module(implListPath, () => ({
  cmdOracleList: async (opts: unknown) => {
    listCalls.push(opts);
    console.log("delegated list");
  },
}));

mock.module(verbosityPath, () => ({
  isQuiet: () => quietMode,
}));

mock.module(registryTypesPath, () => ({
  CACHE_FILE: "/tmp/maw-test-oracles.json",
  LEGACY_CACHE_FILE: "/tmp/legacy-maw-test-oracles.json",
}));

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[]) => {
    parseInputs.push([...args]);
    return parseReturn;
  },
}));

mock.module(costsImplPath, () => ({
  cmdCosts: async () => {
    costsCalls += 1;
    console.log("costs summary");
    if (cmdCostsError) throw cmdCostsError;
  },
  cmdCostsDaily: async (days: number, json: boolean) => {
    dailyCalls.push({ days, json });
    console.error(`daily ${days} ${json}`);
    if (cmdCostsDailyError) throw cmdCostsDailyError;
  },
}));

const { cmdOracleFleet, cmdOracleScan } = await import(
  "../../src/commands/plugins/oracle/impl-scan.ts?oracle-scan-costs-coverage"
);
const costsPlugin = await import("../../src/vendor/mpr-plugins/costs/index.ts?oracle-scan-costs-coverage");
const costsHandler = costsPlugin.default;

function oracle(repo: string, patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo,
    name: repo.replace(/-oracle$/, ""),
    local_path: `/repos/${repo}`,
    has_psi: false,
    ...patch,
  };
}

async function capture(fn: () => Promise<unknown>) {
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors, output: [...logs, ...errors].join("\n") };
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  previousCache = null;
  localCache = { oracles: [] };
  remoteEntries = [];
  fullCache = { oracles: [] };
  quietMode = false;
  scanAndCacheCalls = [];
  scanRemoteCalls = [];
  scanFullCalls = [];
  listCalls = [];

  parseInputs = [];
  parseReturn = {};
  costsCalls = 0;
  dailyCalls = [];
  cmdCostsError = null;
  cmdCostsDailyError = null;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("oracle impl-scan isolated coverage", () => {
  test("remote scan renders verbose rows and remote JSON uses quiet loudness", async () => {
    remoteEntries = [
      oracle("psi-oracle", { has_psi: true }),
      oracle("plain-oracle", { org: "Other", has_psi: false }),
    ];

    const verbose = await capture(() => cmdOracleScan({ remote: true }));
    const plain = stripAnsi(verbose.output);

    expect(scanRemoteCalls).toEqual([{ scope: undefined, loud: true }]);
    expect(plain).toContain("Scanning GitHub orgs for *-oracle repos");
    expect(plain).toContain("Found 2 oracles remotely");
    expect(plain).toContain("Soul-Brews-Studio/psi");
    expect(plain).toContain("Other/plain");

    remoteEntries = [oracle("json-oracle")];
    const json = await capture(() => cmdOracleScan({ remote: true, json: true, quiet: true }));

    expect(scanRemoteCalls.at(-1)).toEqual({ scope: undefined, loud: false });
    expect(stripAnsi(json.logs[0] ?? "")).toContain("Scanning GitHub orgs");
    expect(JSON.parse(json.logs[1] ?? "[]")).toEqual(remoteEntries);
  });

  test("local scan covers first scan, changed deltas, quiet no-change, and JSON output", async () => {
    localCache = { oracles: [oracle("first-oracle"), oracle("second-oracle")] };

    const first = await capture(() => cmdOracleScan());
    const firstPlain = stripAnsi(first.output);

    expect(scanAndCacheCalls).toEqual([{ scope: "local", loud: true }]);
    expect(firstPlain).toContain("added: Soul-Brews-Studio/first-oracle, Soul-Brews-Studio/second-oracle");
    expect(firstPlain).toContain("cache: /tmp/maw-test-oracles.json");
    expect(firstPlain).toContain("2 oracles locally (2 new)");

    previousCache = { oracles: [oracle("old-oracle"), oracle("kept-oracle")] };
    localCache = { oracles: [oracle("kept-oracle"), oracle("new-oracle")] };
    const changed = await capture(() => cmdOracleScan({ local: true }));
    const changedPlain = stripAnsi(changed.output);

    expect(changedPlain).toContain("added: Soul-Brews-Studio/new-oracle");
    expect(changedPlain).toContain("removed: Soul-Brews-Studio/old-oracle");
    expect(changedPlain).toContain("2 oracles locally (+1 -1 since last)");

    previousCache = localCache;
    quietMode = true;
    const quiet = await capture(() => cmdOracleScan({}));
    const quietPlain = stripAnsi(quiet.output);

    expect(scanAndCacheCalls.at(-1)).toEqual({ scope: "local", loud: false });
    expect(quietPlain).toContain("2 oracles locally (no change)");
    expect(quietPlain).not.toContain("cache:");
    expect(quietPlain).not.toContain("added:");

    const asJson = await capture(() => cmdOracleScan({ json: true, quiet: true }));
    expect(JSON.parse(asJson.logs[0] ?? "{}")).toEqual(localCache);
  });

  test("full scan renders local/remote-only counts and honors verbose override for JSON", async () => {
    quietMode = true;
    fullCache = {
      oracles: [
        oracle("local-oracle"),
        oracle("remote-oracle", { local_path: "" }),
      ],
    };

    const full = await capture(() => cmdOracleScan({ all: true }));
    const fullPlain = stripAnsi(full.output);

    expect(scanFullCalls).toEqual([{ scope: undefined, loud: false }]);
    expect(fullPlain).toContain("Full scan: local + GitHub remote");
    expect(fullPlain).toContain("2 oracles (1 local, 1 remote-only)");
    expect(fullPlain).toContain("Cache written to /tmp/maw-test-oracles.json");

    const json = await capture(() => cmdOracleScan({ all: true, json: true, verbose: true }));

    expect(scanFullCalls.at(-1)).toEqual({ scope: undefined, loud: true });
    expect(stripAnsi(json.logs[0] ?? "")).toContain("Full scan: local + GitHub remote");
    expect(JSON.parse(json.logs[1] ?? "{}")).toEqual(fullCache);
  });

  test("fleet alias warns and delegates to oracle list", async () => {
    const captured = await capture(() => cmdOracleFleet({ json: true } as any));

    expect(stripAnsi(captured.errors.join("\n"))).toContain(
      "maw oracle fleet is deprecated — use maw oracle ls instead",
    );
    expect(listCalls).toEqual([{ json: true }]);
    expect(captured.logs).toEqual(["delegated list"]);
  });
});

describe("vendor costs handler isolated coverage", () => {
  test("exports command metadata and captures default CLI output", async () => {
    expect(costsPlugin.command).toMatchObject({
      name: "costs",
      description: "Show token usage and estimated cost breakdown per agent.",
    });

    const result = await costsHandler({ source: "cli", args: [] } as any);

    expect(result).toEqual({ ok: true, output: "costs summary" });
    expect(parseInputs).toEqual([[]]);
    expect(costsCalls).toBe(1);
    expect(dailyCalls).toEqual([]);
  });

  test("injects default daily windows for bare --daily and preserves explicit daily values", async () => {
    parseReturn = { "--daily": 7, "--json": false };
    await costsHandler({ source: "cli", args: ["--daily"] } as any);

    parseReturn = { "--daily": 7, "--json": true };
    await costsHandler({ source: "cli", args: ["--daily", "--json"] } as any);

    parseReturn = { "--daily": 3, "--json": true };
    await costsHandler({ source: "cli", args: ["--daily", "3", "-j"] } as any);

    parseReturn = { "--daily": 0, "--json": false };
    await costsHandler({ source: "cli", args: ["--daily", "0"] } as any);

    expect(parseInputs).toEqual([
      ["--daily", "7"],
      ["--daily", "7", "--json"],
      ["--daily", "3", "-j"],
      ["--daily", "0"],
    ]);
    expect(dailyCalls).toEqual([
      { days: 7, json: false },
      { days: 7, json: true },
      { days: 3, json: true },
      { days: 7, json: false },
    ]);
  });

  test("API source dispatches aggregate, numeric daily, days override, and NaN fallback", async () => {
    await costsHandler({ source: "api", args: {} } as any);
    await costsHandler({ source: "api", args: { daily: "5", json: true } } as any);
    await costsHandler({ source: "api", args: { daily: true, days: "12" } } as any);
    await costsHandler({ source: "api", args: { daily: "not-a-number" } } as any);

    expect(costsCalls).toBe(1);
    expect(dailyCalls).toEqual([
      { days: 5, json: true },
      { days: 12, json: false },
      { days: 7, json: false },
    ]);
  });

  test("writer receives console output and errors preserve captured output", async () => {
    const writerLines: string[] = [];
    parseReturn = { "--daily": 2, "--json": true };

    const withWriter = await costsHandler({
      source: "cli",
      args: ["--daily", "2", "--json"],
      writer: (...args: unknown[]) => writerLines.push(args.map(String).join(" ")),
    } as any);

    expect(withWriter).toEqual({ ok: true, output: undefined });
    expect(writerLines).toEqual(["daily 2 true"]);

    cmdCostsError = new Error("aggregate exploded");
    const aggregateFailure = await costsHandler({ source: "api", args: {} } as any);

    expect(aggregateFailure).toEqual({
      ok: false,
      error: "aggregate exploded",
      output: "costs summary",
    });

    cmdCostsError = null;
    cmdCostsDailyError = new Error("daily exploded");
    parseReturn = { "--daily": 4, "--json": false };
    const dailyFailure = await costsHandler({ source: "cli", args: ["--daily", "4"] } as any);

    expect(dailyFailure).toEqual({
      ok: false,
      error: "daily exploded",
      output: "daily 4 false",
    });
  });
});
