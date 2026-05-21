/** Focused isolated coverage for view impl and oracle prune branches. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OracleEntry } from "../../src/sdk";

type Session = { name: string; windows: Array<{ index: number; name: string }> };

const sdkPath = import.meta.resolve("../../src/sdk");
const splitImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/split/impl");
const staleImplPath = import.meta.resolve("../../src/commands/plugins/oracle/impl-stale");

let sessions: Session[] = [];
let nextHasSession = false;
let configHost = "local";
let socketValue: string | undefined;
let execShouldThrow = false;
let resolveImpl: (agent: string, candidates: Session[]) => unknown;

const tmuxInstances: FakeTmux[] = [];
const execFileCalls: unknown[] = [];
const remoteAttachCalls: unknown[] = [];
const splitCalls: unknown[] = [];
const staleCalls: unknown[] = [];

class FakeTmux {
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor() {
    tmuxInstances.push(this);
  }

  async hasSession(name: string): Promise<boolean> {
    this.calls.push({ method: "hasSession", args: [name] });
    return nextHasSession;
  }

  async newGroupedSession(parent: string, view: string, opts?: unknown): Promise<void> {
    this.calls.push({ method: "newGroupedSession", args: [parent, view, opts] });
  }

  async selectWindow(target: string): Promise<void> {
    this.calls.push({ method: "selectWindow", args: [target] });
  }

  async set(target: string, option: string, value: string): Promise<void> {
    this.calls.push({ method: "set", args: [target, option, value] });
  }

  async switchClient(target: string): Promise<void> {
    this.calls.push({ method: "switchClient", args: [target] });
  }

  async killSession(target: string): Promise<void> {
    this.calls.push({ method: "killSession", args: [target] });
  }
}

const sdkMock = {
  CONFIG_DIR: "/tmp/maw-test-config",
  listSessions: async () => sessions,
  Tmux: FakeTmux,
  resolveSocket: () => socketValue,
  attachRemoteSession: (opts: unknown) => {
    remoteAttachCalls.push(opts);
  },
};

mock.module("maw-js/sdk", () => sdkMock);
mock.module(sdkPath, () => sdkMock);

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ host: configHost }),
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (agent: string, candidates: Session[]) => resolveImpl(agent, candidates),
}));

mock.module("maw-js/core/fleet/audit", () => ({
  logAnomaly: () => undefined,
}));

mock.module("maw-js/commands/shared/wake-resolve", () => ({
  resolveFleetSession: () => null,
}));

mock.module("maw-js/commands/shared/should-auto-wake", () => ({
  shouldAutoWake: () => ({ wake: false, reason: "test" }),
}));

mock.module("child_process", () => ({
  execSync: () => "",
  execFileSync: (...args: unknown[]) => {
    execFileCalls.push(args);
    if (execShouldThrow) throw new Error("tmux attach failed");
    return "";
  },
}));

mock.module(splitImplPath, () => ({
  cmdSplit: async (...args: unknown[]) => {
    splitCalls.push(args);
  },
}));

mock.module(staleImplPath, () => ({
  runStaleScan: async () => [],
}));

const view = await import("../../src/vendor/mpr-plugins/view/impl.ts?vendor-view-oracle-prune-extra-coverage");
const prune = await import("../../src/commands/plugins/oracle/impl-prune.ts?vendor-view-oracle-prune-extra-coverage");

const original = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  tmux: process.env.TMUX,
  mawHost: process.env.MAW_HOST,
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
};

let logs: string[] = [];
let errors: string[] = [];

function captureConsole() {
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
}

function restoreGlobals() {
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  if (original.mawHost === undefined) delete process.env.MAW_HOST;
  else process.env.MAW_HOST = original.mawHost;
  if (original.stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", original.stdinIsTTY);
}

function oracleEntry(patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "oracle-repo",
    name: "oracle",
    local_path: "/repos/oracle",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  sessions = [];
  nextHasSession = false;
  configHost = "local";
  socketValue = undefined;
  execShouldThrow = false;
  tmuxInstances.length = 0;
  execFileCalls.length = 0;
  remoteAttachCalls.length = 0;
  splitCalls.length = 0;
  staleCalls.length = 0;
  process.env.TMUX = "/tmp/tmux,1,0";
  delete process.env.MAW_HOST;
  resolveImpl = (agent, candidates) => {
    const match = candidates.find((s) => s.name === agent);
    return match ? { kind: "exact", match } : { kind: "none", hints: [] };
  };
  captureConsole();
});

afterEach(() => {
  restoreGlobals();
});

describe("vendor view extra branch coverage", () => {
  test("opens an existing view with --split=true without attaching the tmux client", async () => {
    sessions.push({ name: "mawjs-view", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessions[0] });

    await view.cmdView("mawjs-view", { splitAnchor: true });

    expect(splitCalls).toEqual([["mawjs-view", { anchorPane: undefined }]]);
    expect(tmuxInstances[0].calls.some((call) => call.method === "switchClient")).toBe(false);
    expect(execFileCalls).toEqual([]);
  });

  test("bootstraps a missing bare split anchor view and passes its first pane", async () => {
    sessions.push(
      { name: "101-mawjs", windows: [{ index: 0, name: "shell" }] },
      { name: "202-anchor", windows: [{ index: 0, name: "shell" }] },
    );
    resolveImpl = (agent, candidates) => {
      const match = candidates.find((s) => s.name.includes(agent));
      return match ? { kind: "fuzzy", match } : { kind: "none", hints: [] };
    };

    await view.cmdView("mawjs", { splitAnchor: "anchor" });

    expect(tmuxInstances[0].calls).toContainEqual({
      method: "newGroupedSession",
      args: ["101-mawjs", "mawjs-view", { windowSize: "largest" }],
    });
    expect(tmuxInstances[1].calls).toContainEqual({ method: "hasSession", args: ["anchor-view"] });
    expect(tmuxInstances[1].calls).toContainEqual({
      method: "newGroupedSession",
      args: ["202-anchor", "anchor-view", { windowSize: "largest" }],
    });
    expect(splitCalls).toEqual([["mawjs-view", { anchorPane: "anchor-view:0" }]]);
  });



  test("bare split anchors throw when neither an existing view nor source session can be resolved", async () => {
    sessions.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = (agent, candidates) => {
      const match = candidates.find((s) => s.name === agent);
      return match ? { kind: "exact", match } : { kind: "none", hints: [] };
    };

    await expect(view.cmdView("101-mawjs", { splitAnchor: "ghost" })).rejects.toThrow("--split=ghost: no matching session or existing view");
  });

  test("logs failed local attach attempts without throwing", async () => {
    delete process.env.TMUX;
    socketValue = undefined;
    execShouldThrow = true;
    sessions.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessions[0] });

    await view.cmdView("mawjs");

    expect(execFileCalls).toEqual([["tmux", ["attach-session", "-t", "mawjs-view"], { stdio: "inherit" }]]);
    expect(errors.join("\n")).toContain("attach exited non-zero");
  });
});

describe("oracle prune extra branch coverage", () => {
  test("buildPruneCandidates includes only entries with no positive signals and records all reasons", () => {
    const candidates = prune.buildPruneCandidates([
      oracleEntry({ name: "ghost", local_path: "" }),
      oracleEntry({ name: "awake" }),
      oracleEntry({ name: "federated", federation_node: "white" }),
      oracleEntry({ name: "lineaged", has_psi: true }),
    ], new Set(["awake"]));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].entry.name).toBe("ghost");
    expect(candidates[0].reasons).toEqual(["empty lineage", "not cloned", "no tmux", "no federation"]);
  });

  test("buildStaleCandidates keeps only STALE and DEAD tiers with tier-specific reasons", () => {
    const candidates = prune.buildStaleCandidates([
      { ...oracleEntry({ name: "fresh", has_psi: true }), tier: "FRESH", recommendation: "keep", awake: false },
      { ...oracleEntry({ name: "stale", has_psi: true }), tier: "STALE", recommendation: "review", awake: true },
      { ...oracleEntry({ name: "dead", has_psi: true }), tier: "DEAD", recommendation: "retire", awake: false },
    ]);

    expect(candidates.map((candidate) => candidate.entry.name)).toEqual(["stale", "dead"]);
    expect(candidates[0].reasons).toEqual(["STALE (30-90d)", "review"]);
    expect(candidates[1].reasons).toEqual(["DEAD (>90d)", "retire", "no tmux"]);
  });

  test("cmdOraclePrune prints JSON and leaves the registry untouched in dry-run mode", async () => {
    const rawCache = { oracles: [oracleEntry({ name: "ghost", local_path: "" })], retired: [] };
    const writes: unknown[] = [];

    await prune.cmdOraclePrune({ json: true }, {
      readRawCache: () => rawCache,
      writeRawCache: (data) => writes.push(data),
      listAwake: async () => new Set<string>(),
    });

    expect(writes).toEqual([]);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload).toMatchObject({ schema: 1, count: 1, dry_run: true });
    expect(payload.candidates[0].entry.name).toBe("ghost");
  });

  test("cmdOraclePrune aborts force retirement when confirmation is declined", async () => {
    const rawCache = { oracles: [oracleEntry({ name: "ghost", local_path: "" })], retired: [] };
    const writes: unknown[] = [];

    await prune.cmdOraclePrune({ force: true }, {
      readRawCache: () => rawCache,
      writeRawCache: (data) => writes.push(data),
      listAwake: async () => new Set<string>(),
      promptConfirm: async () => false,
    });

    expect(writes).toEqual([]);
    expect(logs.join("\n")).toContain("Aborted");
  });

  test("cmdOraclePrune retires confirmed candidates and preserves existing retired entries", async () => {
    const kept = oracleEntry({ name: "kept", has_psi: true });
    const ghost = oracleEntry({ name: "ghost", local_path: "" });
    const alreadyRetired = {
      ...oracleEntry({ name: "old" }),
      retired_at: "2026-01-01T00:00:00.000Z",
      retired_reasons: ["old"],
    };
    const rawCache: { oracles: OracleEntry[]; retired: unknown[] } = { oracles: [kept, ghost], retired: [alreadyRetired] };
    const writes: any[] = [];

    await prune.cmdOraclePrune({ force: true }, {
      readRawCache: () => rawCache,
      writeRawCache: (data) => writes.push(structuredClone(data)),
      listAwake: async () => new Set<string>(),
      promptConfirm: async () => true,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].oracles.map((entry: OracleEntry) => entry.name)).toEqual(["kept"]);
    expect(writes[0].retired.map((entry: { name: string }) => entry.name)).toEqual(["old", "ghost"]);
    expect(writes[0].retired[1].retired_reasons).toEqual(["empty lineage", "not cloned", "no tmux", "no federation"]);
    expect(logs.join("\n")).toContain("Retired 1 oracle");
  });

  test("runPrune stale mode delegates scanner inputs and filters stale results", async () => {
    const candidates = await prune.runPrune({ stale: true }, {
      readEntries: () => [oracleEntry({ name: "source" })],
      listAwake: async () => new Set(["source"]),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
      runStale: async (...args: unknown[]) => {
        staleCalls.push(args);
        return [
          { ...oracleEntry({ name: "source", has_psi: true }), tier: "STALE", recommendation: "review", awake: true },
          { ...oracleEntry({ name: "fresh", has_psi: true }), tier: "FRESH", recommendation: "keep", awake: true },
        ];
      },
    });

    expect(staleCalls).toHaveLength(1);
    expect(candidates.map((candidate) => candidate.entry.name)).toEqual(["source"]);
    expect(candidates[0].tier).toBe("STALE");
  });
});
