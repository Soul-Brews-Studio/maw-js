/** Targeted runtime coverage for src/vendor/mpr-plugins/doctor/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const C = { green: "", red: "", yellow: "", gray: "", reset: "" };

let logs: string[] = [];
let execCalls: string[] = [];
let pm2Jlist: string | Error | null = null;
let fetchVersion: string | null = null;
let fetchOk = true;
let peersStore: Record<string, any> = {};
let loadPeersError: Error | null = null;
let configValue: any = { oracle: "mawjs", node: "local" };
let configError: Error | null = null;
let staleCheck = { name: "peers:stale", ok: true, message: "no stale peers" };
let fixStaleResult = { ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "removed 0 stale peers" }] };
let manifestValue: any[] = [];
let manifestError: Error | null = null;
let invalidateCalls = 0;
let branchCheck = { name: "maw-js:branch", ok: true, message: "on alpha" };
let worktreeCheck = { name: "worktrees:stillborn", ok: true, message: "no .wt-* directories found" };

const originalLog = console.log;
const originalFetch = globalThis.fetch;

mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (cmd.includes("pm2 jlist")) {
      if (pm2Jlist instanceof Error) throw pm2Jlist;
      return pm2Jlist ?? "[]";
    }
    throw new Error(`unexpected execSync: ${cmd}`);
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => {
    if (configError) throw configError;
    return configValue;
  },
}));

mock.module("maw-js/commands/shared/fleet-doctor-fixer", () => ({ C }));

mock.module("maw-js/lib/oracle-manifest", () => ({
  invalidateManifest: () => { invalidateCalls += 1; },
  loadManifestCached: () => {
    if (manifestError) throw manifestError;
    return manifestValue;
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/peers-store"), () => ({
  loadPeers: () => {
    if (loadPeersError) throw loadPeersError;
    return { version: 1, peers: peersStore };
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stale-peers"), () => ({
  checkStalePeers: () => staleCheck,
  cmdFixStalePeers: async () => fixStaleResult,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/maw-js-branch-check"), () => ({
  checkMawJsBranch: async () => branchCheck,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stillborn-worktrees"), () => ({
  checkStillbornWorktrees: () => worktreeCheck,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/bun-link-detect"), () => ({
  detectBunLinkedCheckout: () => null,
}));

const { cmdDoctor } = await import("../../src/vendor/mpr-plugins/doctor/impl.ts?doctor-impl-runtime-coverage");

beforeEach(() => {
  logs = [];
  execCalls = [];
  pm2Jlist = null;
  fetchVersion = null;
  fetchOk = true;
  peersStore = {};
  loadPeersError = null;
  configValue = { oracle: "mawjs", node: "local" };
  configError = null;
  staleCheck = { name: "peers:stale", ok: true, message: "no stale peers" };
  fixStaleResult = { ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "removed 0 stale peers" }] };
  manifestValue = [];
  manifestError = null;
  invalidateCalls = 0;
  branchCheck = { name: "maw-js:branch", ok: true, message: "on alpha" };
  worktreeCheck = { name: "worktrees:stillborn", ok: true, message: "no .wt-* directories found" };
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
  globalThis.fetch = (async (url: string | URL | Request) => {
    return {
      ok: fetchOk,
      json: async () => (fetchVersion === null ? {} : { version: fetchVersion }),
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
});

describe("doctor impl runtime coverage", () => {
  test("--fix-stale returns stale-peer fix result without rendering the normal suite", async () => {
    fixStaleResult = {
      ok: true,
      checks: [{ name: "peers:fix-stale", ok: true, message: "removed 2 stale peers" }],
    };

    const result = await cmdDoctor(["--fix-stale"]);

    expect(result).toEqual(fixStaleResult);
    expect(logs).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("xdg check prints config, state, data, and cache roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-doctor-xdg-"));
    const home = join(root, "home");
    const xdgConfig = join(root, "xdg-config");
    const xdgState = join(root, "xdg-state");
    const xdgData = join(root, "xdg-data");
    const xdgCache = join(root, "xdg-cache");
    const original = {
      mawHome: process.env.MAW_HOME,
      mawXdg: process.env.MAW_XDG,
      home: process.env.HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      xdgState: process.env.XDG_STATE_HOME,
      xdgData: process.env.XDG_DATA_HOME,
      xdgCache: process.env.XDG_CACHE_HOME,
    };
    try {
      delete process.env.MAW_HOME;
      process.env.HOME = home;
      process.env.MAW_XDG = "1";
      process.env.XDG_CONFIG_HOME = xdgConfig;
      process.env.XDG_STATE_HOME = xdgState;
      process.env.XDG_DATA_HOME = xdgData;
      process.env.XDG_CACHE_HOME = xdgCache;
      mkdirSync(join(xdgConfig, "maw", "snapshots"), { recursive: true });
      writeFileSync(join(xdgConfig, "maw", "audit.jsonl"), "{}\n");
      mkdirSync(join(home, ".maw"), { recursive: true });
      writeFileSync(join(home, ".maw", "peers.json"), "{}\n");

      const result = await cmdDoctor(["xdg"]);

      expect(result.ok).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.name).toBe("xdg:paths");
      expect(result.checks[0]?.message).toContain("MAW_XDG=on");
      expect(result.checks[0]?.message).toContain(`config=${join(xdgConfig, "maw")}`);
      expect(result.checks[0]?.message).toContain(`state=${join(xdgState, "maw")}`);
      expect(result.checks[0]?.message).toContain(`data=${join(xdgData, "maw")}`);
      expect(result.checks[0]?.message).toContain(`cache=${join(xdgCache, "maw")}`);
      expect(result.checks[0]?.message).toContain("config-runtime=2 [audit.jsonl,snapshots]");
      expect(result.checks[0]?.message).toContain("legacy-runtime=1 [peers.json]");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (original.mawHome === undefined) delete process.env.MAW_HOME;
      else process.env.MAW_HOME = original.mawHome;
      if (original.mawXdg === undefined) delete process.env.MAW_XDG;
      else process.env.MAW_XDG = original.mawXdg;
      if (original.home === undefined) delete process.env.HOME;
      else process.env.HOME = original.home;
      if (original.xdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original.xdgConfig;
      if (original.xdgState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original.xdgState;
      if (original.xdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original.xdgData;
      if (original.xdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = original.xdgCache;
    }
  });

  test("xdg check distinguishes config-only and legacy-only runtime migration guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-doctor-xdg-guidance-"));
    const original = {
      mawHome: process.env.MAW_HOME,
      mawXdg: process.env.MAW_XDG,
      home: process.env.HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
    };
    try {
      delete process.env.MAW_HOME;
      process.env.HOME = join(root, "home");
      process.env.XDG_CONFIG_HOME = join(root, "xdg-config");

      mkdirSync(join(process.env.XDG_CONFIG_HOME, "maw"), { recursive: true });
      writeFileSync(join(process.env.XDG_CONFIG_HOME, "maw", "audit.jsonl"), "{}\n");
      delete process.env.MAW_XDG;
      const configOnly = await cmdDoctor(["xdg"]);
      expect(configOnly.checks[0]!.message).toContain("action=config-runtime-state");

      rmSync(root, { recursive: true, force: true });
      mkdirSync(join(process.env.HOME, ".maw"), { recursive: true });
      writeFileSync(join(process.env.HOME, ".maw", "peers.json"), "{}\n");
      process.env.MAW_XDG = "1";
      const legacyOnly = await cmdDoctor(["xdg"]);
      expect(legacyOnly.checks[0]!.message).toContain("action=legacy-runtime-state");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (original.mawHome === undefined) delete process.env.MAW_HOME;
      else process.env.MAW_HOME = original.mawHome;
      if (original.mawXdg === undefined) delete process.env.MAW_XDG;
      else process.env.MAW_XDG = original.mawXdg;
      if (original.home === undefined) delete process.env.HOME;
      else process.env.HOME = original.home;
      if (original.xdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original.xdgConfig;
    }
  });

  test("xdg migration dry-run reports config and legacy artifacts as structured JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-doctor-xdg-migrate-dry-"));
    const original = {
      mawHome: process.env.MAW_HOME,
      home: process.env.HOME,
      config: process.env.MAW_CONFIG_DIR,
      state: process.env.MAW_STATE_DIR,
      data: process.env.MAW_DATA_DIR,
      cache: process.env.MAW_CACHE_DIR,
      xdgState: process.env.XDG_STATE_HOME,
      xdgData: process.env.XDG_DATA_HOME,
      xdgCache: process.env.XDG_CACHE_HOME,
    };
    try {
      delete process.env.MAW_HOME;
      process.env.HOME = join(root, "home");
      process.env.MAW_CONFIG_DIR = join(root, "config");
      process.env.MAW_STATE_DIR = join(root, "state");
      process.env.MAW_DATA_DIR = join(root, "data");
      process.env.MAW_CACHE_DIR = join(root, "cache");
      mkdirSync(process.env.MAW_CONFIG_DIR, { recursive: true });
      mkdirSync(join(process.env.HOME, ".maw"), { recursive: true });
      mkdirSync(process.env.MAW_STATE_DIR, { recursive: true });
      writeFileSync(join(process.env.MAW_CONFIG_DIR, "audit.jsonl"), "{}\n");
      writeFileSync(join(process.env.MAW_CONFIG_DIR, "message-ledger.sqlite"), "sqlite-ish");
      writeFileSync(join(process.env.MAW_CONFIG_DIR, "fleet-resume.log"), "already copied");
      writeFileSync(join(process.env.MAW_STATE_DIR, "fleet-resume.log"), "keep me");
      writeFileSync(join(process.env.HOME, ".maw", "nicknames.json"), "{}\n");
      logs = [];

      const result = await cmdDoctor(["xdg", "--migrate", "--dry-run", "--json"]);

      expect(result.ok).toBe(true);
      expect(result.checks[0]!.name).toBe("xdg:migrate");
      expect(result.checks[0]!.message).toContain("dry-run");
      expect(result.checks[0]!.message).toContain("planned=3");
      expect(result.checks[0]!.message).toContain("exists=1");
      const rendered = JSON.parse(logs.join("\n"));
      expect(rendered.checks[0].details.targets).toEqual({
        state: process.env.MAW_STATE_DIR,
        data: process.env.MAW_DATA_DIR,
        cache: process.env.MAW_CACHE_DIR,
      });
      expect(rendered.checks[0].details.items.some((item: any) => item.name === "audit.jsonl" && item.outcome === "dry-run")).toBe(true);
      expect(rendered.checks[0].details.items.some((item: any) => item.name === "fleet-resume.log" && item.outcome === "exists")).toBe(true);

      delete process.env.MAW_STATE_DIR;
      delete process.env.MAW_DATA_DIR;
      delete process.env.MAW_CACHE_DIR;
      process.env.XDG_STATE_HOME = join(root, "xdg-state");
      process.env.XDG_DATA_HOME = join(root, "xdg-data");
      process.env.XDG_CACHE_HOME = join(root, "xdg-cache");
      logs = [];
      const xdgDefaults = await cmdDoctor(["xdg", "--migrate", "--dry-run", "--json"]);
      expect(xdgDefaults.ok).toBe(true);
      expect(JSON.parse(logs.join("\n")).checks[0].details.targets).toEqual({
        state: join(root, "xdg-state", "maw"),
        data: join(root, "xdg-data", "maw"),
        cache: join(root, "xdg-cache", "maw"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (original.mawHome === undefined) delete process.env.MAW_HOME;
      else process.env.MAW_HOME = original.mawHome;
      if (original.home === undefined) delete process.env.HOME;
      else process.env.HOME = original.home;
      if (original.config === undefined) delete process.env.MAW_CONFIG_DIR;
      else process.env.MAW_CONFIG_DIR = original.config;
      if (original.state === undefined) delete process.env.MAW_STATE_DIR;
      else process.env.MAW_STATE_DIR = original.state;
      if (original.data === undefined) delete process.env.MAW_DATA_DIR;
      else process.env.MAW_DATA_DIR = original.data;
      if (original.cache === undefined) delete process.env.MAW_CACHE_DIR;
      else process.env.MAW_CACHE_DIR = original.cache;
      if (original.xdgState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original.xdgState;
      if (original.xdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original.xdgData;
      if (original.xdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = original.xdgCache;
    }
  });

  test("xdg migration apply covers copy, same-path, MAW_HOME, and error outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-doctor-xdg-migrate-apply-"));
    const original = {
      mawHome: process.env.MAW_HOME,
      home: process.env.HOME,
      config: process.env.MAW_CONFIG_DIR,
      state: process.env.MAW_STATE_DIR,
      data: process.env.MAW_DATA_DIR,
      cache: process.env.MAW_CACHE_DIR,
    };
    try {
      process.env.MAW_HOME = join(root, "instance");
      process.env.HOME = join(root, "home-for-maw-home");
      mkdirSync(process.env.HOME, { recursive: true });
      delete process.env.MAW_CONFIG_DIR;
      delete process.env.MAW_STATE_DIR;
      delete process.env.MAW_DATA_DIR;
      delete process.env.MAW_CACHE_DIR;
      mkdirSync(join(process.env.MAW_HOME, "config"), { recursive: true });
      writeFileSync(join(process.env.MAW_HOME, "config", "audit.jsonl"), "copy me");

      const copied = await cmdDoctor(["xdg", "--migrate"]);
      expect(copied.checks[0]!.message).toContain("copied=1");
      expect(readFileSync(join(process.env.MAW_HOME, "audit.jsonl"), "utf-8")).toBe("copy me");

      delete process.env.MAW_HOME;
      process.env.HOME = join(root, "home");
      process.env.MAW_CONFIG_DIR = join(root, "shared");
      process.env.MAW_STATE_DIR = join(root, "shared");
      process.env.MAW_DATA_DIR = join(root, "data");
      process.env.MAW_CACHE_DIR = join(root, "cache");
      mkdirSync(process.env.MAW_CONFIG_DIR, { recursive: true });
      writeFileSync(join(process.env.MAW_CONFIG_DIR, "audit.jsonl"), "same");
      const same = await cmdDoctor(["xdg", "--migrate"]);
      expect(same.checks[0]!.message).toContain("same=1");

      process.env.MAW_CONFIG_DIR = join(root, "config-error");
      process.env.MAW_STATE_DIR = join(root, "state-blocker");
      mkdirSync(process.env.MAW_CONFIG_DIR, { recursive: true });
      writeFileSync(join(process.env.MAW_CONFIG_DIR, "audit.jsonl"), "cannot copy");
      writeFileSync(process.env.MAW_STATE_DIR, "not a directory");
      const errored = await cmdDoctor(["xdg", "--migrate"]);
      expect(errored.ok).toBe(false);
      expect(errored.checks[0]!.message).toContain("errors=1");
      expect(errored.checks[0]!.details).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (original.mawHome === undefined) delete process.env.MAW_HOME;
      else process.env.MAW_HOME = original.mawHome;
      if (original.home === undefined) delete process.env.HOME;
      else process.env.HOME = original.home;
      if (original.config === undefined) delete process.env.MAW_CONFIG_DIR;
      else process.env.MAW_CONFIG_DIR = original.config;
      if (original.state === undefined) delete process.env.MAW_STATE_DIR;
      else process.env.MAW_STATE_DIR = original.state;
      if (original.data === undefined) delete process.env.MAW_DATA_DIR;
      else process.env.MAW_DATA_DIR = original.data;
      if (original.cache === undefined) delete process.env.MAW_CACHE_DIR;
      else process.env.MAW_CACHE_DIR = original.cache;
    }
  });

  test("version check reports drift and --allow-drift downgrades version-only failures", async () => {
    pm2Jlist = JSON.stringify([
      { name: "maw", pm_id: 7, pm2_env: { env: { MAW_PORT: "4567" } } },
    ]);
    fetchVersion = "0.0.0-test-drift";

    const drift = await cmdDoctor(["version"]);
    const allowed = await cmdDoctor(["version", "--allow-drift"]);

    expect(drift.ok).toBe(false);
    expect(drift.checks).toHaveLength(1);
    expect(drift.checks[0]!.name).toBe("version:maw#7");
    expect(drift.checks[0]!.message).toContain("drift — running 0.0.0-test-drift");
    expect(drift.checks[0]!.message).toContain(":4567");
    expect(allowed.ok).toBe(true);
    expect(execCalls).toEqual(["pm2 jlist 2>/dev/null", "pm2 jlist 2>/dev/null"]);
  });

  test("peers check surfaces duplicate local identity while preserving stale-peer result", async () => {
    peersStore = {
      twin: {
        url: "http://peer.example:3456",
        node: "local",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-02T00:00:00.000Z",
        identity: { oracle: "mawjs", node: "local" },
      },
    };
    staleCheck = { name: "peers:stale", ok: false, message: "1 stale peer (>30d) — run 'maw doctor --fix-stale' to remove" };

    const result = await cmdDoctor(["peers"]);

    expect(result.ok).toBe(false);
    expect(result.checks.map(c => c.name)).toEqual(["peers:duplicates", "peers:stale"]);
    expect(result.checks[0]!.ok).toBe(false);
    expect(result.checks[0]!.message).toContain('duplicate <oracle>:<node> claim "mawjs:local"');
    expect(result.checks[0]!.message).toContain("<local>");
    expect(result.checks[0]!.message).toContain("twin (http://peer.example:3456)");
    expect(result.checks[1]).toEqual(staleCheck);
  });

  test("peers check is fail-soft for unreadable cache and unreadable config", async () => {
    loadPeersError = new Error("cache corrupt");

    const unreadableCache = await cmdDoctor(["peers"]);

    expect(unreadableCache.ok).toBe(true);
    expect(unreadableCache.checks[0]).toEqual({
      name: "peers:duplicates",
      ok: true,
      message: "peer cache unreadable (cache corrupt) — skipping dedup check",
    });

    loadPeersError = null;
    configError = new Error("bad config");
    peersStore = {
      solo: {
        url: "http://solo.example:3456",
        node: "remote",
        addedAt: "2026-01-01T00:00:00.000Z",
        identity: { oracle: "solo", node: "remote" },
      },
    };

    const unreadableConfig = await cmdDoctor(["peers"]);

    expect(unreadableConfig.ok).toBe(true);
    expect(unreadableConfig.checks[0]).toEqual({
      name: "peers:duplicates",
      ok: true,
      message: "no <oracle>:<node> collisions across 1 peer",
    });
  });

  test("version check handles pm2 parse failures, missing env ports, unreachable fetches, and aligned versions", async () => {
    pm2Jlist = "not json";
    await expect(cmdDoctor(["version"])).resolves.toMatchObject({
      ok: true,
      checks: [{ name: "version:pm2", ok: true }],
    });

    pm2Jlist = JSON.stringify([
      null,
      { name: "other", pm_id: 1, pm2_env: { env: { MAW_PORT: "4444" } } },
      { name: "maw-worker", pm_id: 2, pm2_env: { env: { PORT: "4568" } } },
      { name: "maw", pm_id: 3, pm2_env: { env: { MAW_PORT: "not-a-port" } } },
    ]);
    fetchOk = false;
    const unreachable = await cmdDoctor(["version"]);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.checks.map(c => c.name)).toEqual(["version:maw-worker#2", "version:maw#3"]);
    expect(unreachable.checks[0]!.message).toContain("unreachable at :4568");
    expect(unreachable.checks[1]!.message).toContain("unreachable at :3456");

    fetchOk = true;
    const sourceMatch = unreachable.checks[0]!.message.match(/source ([^ ]+)/);
    expect(sourceMatch).not.toBeNull();
    fetchVersion = sourceMatch![1]!;
    const aligned = await cmdDoctor(["version"]);
    expect(aligned.ok).toBe(true);
    expect(aligned.checks.every(c => c.message.startsWith("aligned"))).toBe(true);
  });

  test("manifest check invalidates cache, reports cross-source gaps, and remains warning-only", async () => {
    manifestValue = [
      { name: "ghost", node: "local", sources: ["agent"] },
      { name: "orphan", sources: ["oracles-json"] },
    ];

    const result = await cmdDoctor(["manifest"]);

    expect(result.ok).toBe(true);
    expect(invalidateCalls).toBe(1);
    expect(result.checks).toEqual([
      {
        name: "manifest:cross-source",
        ok: true,
        message: "2 cross-source gaps (agent-without-fleet×1, oracles-json-without-runtime×1)",
      },
    ]);
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).toContain("[agent-without-fleet]");
    expect(joinedLogs).toContain("[oracles-json-without-runtime]");
  });

  test("manifest check skips unreadable manifests as a non-fatal doctor warning", async () => {
    manifestError = new Error("manifest boom");

    const result = await cmdDoctor(["manifest"]);

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      { name: "manifest:cross-source", ok: true, message: "manifest unreadable (manifest boom) — skipping cross-source check" },
    ]);
  });
});
