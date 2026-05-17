/**
 * federation-sync-cli.ts — default-suite coverage through explicit DI.
 *
 * The isolated suite still owns mock.module compatibility. This file keeps the
 * default runner on the CLI formatter/orchestrator without network or disk I/O.
 */
import { describe, expect, test } from "bun:test";
import type { MawConfig, PeerConfig } from "../src/config";
import {
  cmdFederationSync,
  federationSyncDeps,
  type FederationSyncDeps,
  type SyncOptions,
} from "../src/commands/shared/federation-sync-cli";
import { computeSyncDiff } from "../src/commands/shared/federation-diff";
import { applySyncDiff } from "../src/commands/shared/federation-apply";
import type { PeerIdentity, SyncDiff } from "../src/commands/shared/federation-identity";

function peer(
  peerName: string,
  node: string,
  agents: string[],
  reachable = true,
  error?: string,
): PeerIdentity {
  return {
    peerName,
    url: `https://${peerName}.example`,
    node,
    agents,
    reachable,
    ...(error !== undefined ? { error } : {}),
  };
}

interface HarnessOptions {
  config?: Partial<MawConfig>;
  identities?: PeerIdentity[];
  deps?: Partial<FederationSyncDeps>;
}

function makeHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const exits: number[] = [];
  const saves: Array<Partial<MawConfig>> = [];
  const fetchCalls: PeerConfig[][] = [];
  const config = options.config ?? {};
  const identities = options.identities ?? [];

  const deps = federationSyncDeps({
    loadConfig: () => config as MawConfig,
    fetchPeerIdentities: async (peers: PeerConfig[]) => {
      fetchCalls.push(peers);
      return identities;
    },
    computeSyncDiff,
    applySyncDiff,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    exit: (code = 0): never => {
      exits.push(code);
      throw new Error(`__exit__:${code}`);
    },
    ...options.deps,
  });

  const save = (update: Partial<MawConfig>) => {
    saves.push(update);
  };

  async function run(opts: SyncOptions = {}) {
    try {
      await cmdFederationSync(opts, save, deps);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.startsWith("__exit__")) throw e;
    }
  }

  return { deps, logs, exits, saves, fetchCalls, run };
}

function joined(logs: string[]) {
  return logs.join("\n");
}

describe("federationSyncDeps", () => {
  test("returns production defaults with requested overrides", () => {
    const loadConfig = () => ({ node: "test" }) as MawConfig;
    const deps = federationSyncDeps({ loadConfig });

    expect(deps.loadConfig).toBe(loadConfig);
    expect(typeof deps.fetchPeerIdentities).toBe("function");
    expect(typeof deps.computeSyncDiff).toBe("function");
    expect(typeof deps.applySyncDiff).toBe("function");
    expect(typeof deps.log).toBe("function");
    expect(typeof deps.exit).toBe("function");
  });

  test("default log and exit delegates are callable", () => {
    const deps = federationSyncDeps();
    const origLog = console.log;
    const origExit = process.exit;
    const logs: string[] = [];
    let exitCode: number | undefined;

    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    (process as unknown as { exit: (code?: number) => never }).exit = (code = 0): never => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    };

    try {
      deps.log("hello", "world");
      expect(() => deps.exit(7)).toThrow("__exit__:7");
    } finally {
      console.log = origLog;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }

    expect(logs).toEqual(["hello world"]);
    expect(exitCode).toBe(7);
  });
});

describe("cmdFederationSync default coverage", () => {
  test("text mode exits cleanly when namedPeers is empty", async () => {
    const h = makeHarness({ config: { node: "white", namedPeers: [], agents: {} } });

    await h.run();

    expect(h.exits).toEqual([0]);
    expect(joined(h.logs)).toContain("no namedPeers configured");
    expect(h.fetchCalls).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  test("json mode reports local node fallback when there are no peers", async () => {
    const h = makeHarness({ config: { agents: {} } });

    await h.run({ json: true });

    expect(h.exits).toEqual([0]);
    expect(JSON.parse(h.logs[0])).toEqual({ node: "local", diff: null, reason: "no peers" });
  });

  test("json mode exits 1 for dirty --check output and includes dryRun", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: {},
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run({ json: true, check: true, dryRun: true });

    expect(h.exits).toEqual([1]);
    const payload = JSON.parse(h.logs[0]);
    expect(payload.node).toBe("m5");
    expect(payload.dryRun).toBe(true);
    expect(payload.diff.add).toEqual([{ oracle: "neo", peerNode: "white", fromPeer: "white" }]);
  });

  test("json mode exits 0 for clean output", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { neo: "white" },
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run({ json: true, check: true });

    expect(h.exits).toEqual([0]);
    const payload = JSON.parse(h.logs[0]);
    expect(payload.diff).toMatchObject({ add: [], stale: [], conflict: [], unreachable: [] });
  });

  test("renders reachable adds/conflicts/stale entries and unreachable errors in dry-run mode", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [
          { name: "white", url: "https://white.example" },
          { name: "dead", url: "https://dead.example" },
        ],
        agents: { existing: "old-node", stale: "white", local: "local" },
      },
      identities: [
        peer("white", "white", ["neo", "existing"]),
        peer("dead", "", [], false, "timeout"),
      ],
    });

    await h.run({ dryRun: true });

    const out = joined(h.logs);
    expect(h.exits).toEqual([0]);
    expect(out).toContain("Federation Sync");
    expect(out).toContain("unreachable");
    expect(out).toContain("timeout");
    expect(out).toContain("+\u001b[0m neo");
    expect(out).toContain("~\u001b[0m existing");
    expect(out).toContain("-\u001b[0m stale");
    expect(out).toContain("dry run");
    expect(h.saves).toEqual([]);
  });

  test("prints in-sync summary when no diff is dirty", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { neo: "white" },
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run();

    expect(h.exits).toEqual([0]);
    expect(joined(h.logs)).toContain("in sync");
  });

  test("conflicts fail loudly unless force, dry-run, or check is requested", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { neo: "old-node" },
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run();

    expect(h.exits).toEqual([2]);
    expect(joined(h.logs)).toContain("rerun with");
    expect(joined(h.logs)).toContain("--force");
    expect(h.saves).toEqual([]);
  });

  test("stale entries without prune warn and then apply no changes", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { stale: "white" },
      },
      identities: [peer("white", "white", [])],
    });

    await h.run();

    expect(h.exits).toEqual([0]);
    const out = joined(h.logs);
    expect(out).toContain("stale entry");
    expect(out).toContain("--prune");
    expect(out).toContain("no changes applied");
    expect(h.saves).toEqual([]);
  });

  test("check mode reports out-of-sync summary and exits 1", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: {},
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run({ check: true });

    expect(h.exits).toEqual([1]);
    expect(joined(h.logs)).toContain("out of sync: 1 add · 0 conflict · 0 stale");
  });

  test("applies additions and saves the next agents map", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { local: "local" },
      },
      identities: [peer("white", "white", ["neo"])],
    });

    await h.run();

    expect(h.exits).toEqual([0]);
    expect(h.saves).toEqual([{ agents: { local: "local", neo: "white" } }]);
    expect(joined(h.logs)).toContain("applied 1 change");
  });

  test("force and prune pass through to applySyncDiff", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: { conflict: "old-node", stale: "white" },
      },
      identities: [peer("white", "white", ["conflict"])],
    });

    await h.run({ force: true, prune: true });

    expect(h.exits).toEqual([0]);
    expect(h.saves).toEqual([{ agents: { conflict: "white" } }]);
    const out = joined(h.logs);
    expect(out).toContain("applied 2 changes");
    expect(out).toContain("--force");
  });

  test("custom apply dependency can report dirty diff with no applied changes", async () => {
    const diff: SyncDiff = {
      add: [{ oracle: "neo", peerNode: "white", fromPeer: "white" }],
      stale: [],
      conflict: [],
      unreachable: [],
    };
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: {},
      },
      identities: [peer("white", "white", ["neo"])],
      deps: {
        computeSyncDiff: () => diff,
        applySyncDiff: () => ({ agents: {}, applied: [] }),
      },
    });

    await h.run();

    expect(h.exits).toEqual([0]);
    expect(h.saves).toEqual([]);
    expect(joined(h.logs)).toContain("no changes applied");
  });

  test("omitted save callback exercises the lazy default save shim safely", async () => {
    const h = makeHarness({
      config: {
        node: "m5",
        namedPeers: [{ name: "white", url: "https://white.example" }],
        agents: {},
      },
      identities: [peer("white", "white", ["neo"])],
    });
    const previousTestMode = process.env.MAW_TEST_MODE;
    process.env.MAW_TEST_MODE = "1";

    try {
      await cmdFederationSync({}, undefined as never, h.deps);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // If the config module resolved to the real home config, #820's guard
      // proves the lazy shim was reached without risking developer state.
      // If the runner already sandboxed MAW_HOME/MAW_CONFIG_DIR, the command
      // may instead persist to that sandbox and exit through the injected seam.
      if (!message.includes("saveConfig refused") && !message.startsWith("__exit__")) throw e;
    } finally {
      if (previousTestMode === undefined) {
        delete process.env.MAW_TEST_MODE;
      } else {
        process.env.MAW_TEST_MODE = previousTestMode;
      }
    }

    expect(h.saves).toEqual([]);
  });
});
