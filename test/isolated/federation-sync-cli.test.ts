/**
 * federation-sync-cli.ts — cmdFederationSync entry point.
 *
 * The CLI orchestrates: loadConfig → fetchPeerIdentities → computeSyncDiff
 * → (optional) applySyncDiff + save. Pure logic (computeSyncDiff,
 * applySyncDiff) is exhaustively covered in test/federation-sync.test.ts;
 * here we drive every output / exit-code branch of the CLI shell.
 *
 * Isolated because we mock.module on two seams cmdFederationSync imports
 * through:
 *   - src/config                              (loadConfig)
 *   - src/commands/shared/federation-fetch    (fetchPeerIdentities)
 *
 * The `save` callback is injected via cmdFederationSync's second argument,
 * so we capture writes directly without needing to mock saveConfig.
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 *
 * process.exit is stubbed to throw a sentinel so we observe each exit-code
 * branch without tearing the runner down.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import type { MawConfig } from "../../src/config";
import type { PeerIdentity } from "../../src/commands/shared/federation-identity";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;
const realSaveConfig = _rConfig.saveConfig;

const _rFetch = await import("../../src/commands/shared/federation-fetch");
const realFetchPeerIdentities = _rFetch.fetchPeerIdentities;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

let configStore: Partial<MawConfig> = {};
let fetchReturn: PeerIdentity[] = [];
let fetchCalls: Array<{ peers: unknown }> = [];
let saveCalls: Array<Partial<MawConfig>> = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: unknown[]) =>
      mockActive ? (configStore as MawConfig) : (realLoadConfig as (...a: unknown[]) => MawConfig)(...args),
    saveConfig: (...args: unknown[]) => {
      if (mockActive) {
        const [update] = args as [Partial<MawConfig>];
        saveCalls.push(update);
        return;
      }
      return (realSaveConfig as (...a: unknown[]) => unknown)(...args);
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/shared/federation-fetch"),
  () => ({
    ..._rFetch,
    fetchPeerIdentities: async (...args: unknown[]) => {
      if (!mockActive) {
        return (realFetchPeerIdentities as (...a: unknown[]) => Promise<PeerIdentity[]>)(...args);
      }
      const [peers] = args as [unknown];
      fetchCalls.push({ peers });
      return fetchReturn;
    },
  }),
);

// NB: import target AFTER mocks so its import graph resolves through our stubs.
const { cmdFederationSync } = await import("../../src/commands/shared/federation-sync-cli");

// ─── stdout + process.exit harness ──────────────────────────────────────────

const origLog = console.log;
const origExit = process.exit;

let outs: string[] = [];
let exitCode: number | undefined;

async function run(fn: () => Promise<void>): Promise<void> {
  outs = []; exitCode = undefined;
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

const captureSave = (update: Partial<MawConfig>) => { saveCalls.push(update); };

// ─── Fixture helpers ────────────────────────────────────────────────────────

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

beforeEach(() => {
  mockActive = true;
  configStore = {};
  fetchReturn = [];
  fetchCalls = [];
  saveCalls = [];
});

afterEach(() => { mockActive = false; });
afterAll(() => {
  mockActive = false;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

// ════════════════════════════════════════════════════════════════════════════
// no peers configured
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — no namedPeers configured", () => {
  test("text mode → grey 'no namedPeers configured' + exit 0; fetch never called", async () => {
    configStore = { node: "white", namedPeers: [], agents: {} };

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("no namedPeers configured — nothing to sync");
    expect(fetchCalls).toEqual([]);
    expect(saveCalls).toEqual([]);
  });

  test("namedPeers undefined → same path as empty array", async () => {
    configStore = { node: "white", agents: {} };

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("no namedPeers configured");
    expect(fetchCalls).toEqual([]);
  });

  test("json mode → single-line JSON{node,diff:null,reason:'no peers'} + exit 0", async () => {
    configStore = { node: "oracle-world", namedPeers: [], agents: {} };

    await run(() => cmdFederationSync({ json: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(outs).toHaveLength(1);
    const parsed = JSON.parse(outs[0]);
    expect(parsed).toEqual({ node: "oracle-world", diff: null, reason: "no peers" });
  });

  test("missing node defaults to 'local' in the JSON payload", async () => {
    configStore = { namedPeers: [], agents: {} };

    await run(() => cmdFederationSync({ json: true }, captureSave));

    const parsed = JSON.parse(outs[0]);
    expect(parsed.node).toBe("local");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// JSON output (with peers)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — JSON output", () => {
  test("clean diff → exit 0 with full diff payload (pretty-printed, 2-space indent)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ json: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(outs).toHaveLength(1);
    const parsed = JSON.parse(outs[0]);
    expect(parsed.node).toBe("oracle-world");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.diff.add).toEqual([]);
    expect(parsed.diff.stale).toEqual([]);
    expect(parsed.diff.conflict).toEqual([]);
    // Pretty-printed: contains a newline + indent
    expect(outs[0]).toContain("\n  ");
  });

  test("dirty diff + check → exit 1 (CI signal)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({ json: true, check: true }, captureSave));

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(outs[0]);
    expect(parsed.diff.add).toHaveLength(1);
    expect(parsed.diff.add[0].oracle).toBe("pulse");
  });

  test("clean diff + check → exit 0 (in sync)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ json: true, check: true }, captureSave));

    expect(exitCode).toBe(0);
  });

  test("dirty diff WITHOUT check → exit 0 (informational only)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({ json: true }, captureSave));

    expect(exitCode).toBe(0);
  });

  test("dryRun flag is reflected in JSON payload", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({ json: true, dryRun: true }, captureSave));

    const parsed = JSON.parse(outs[0]);
    expect(parsed.dryRun).toBe(true);
  });

  test("JSON path NEVER calls save (read-only signal)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({ json: true }, captureSave));

    expect(saveCalls).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// in-sync path (no diff)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — clean (in sync)", () => {
  test("zero diff entries → green '✓ in sync' + exit 0; no save", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    const joined = outs.join("\n");
    expect(joined).toContain("in sync.");
    // Green ✓ marker
    expect(joined).toContain("\x1b[32m✓\x1b[0m");
    // Unreachable count is part of the in-sync line
    expect(joined).toContain("(0 peers unreachable)");
    expect(saveCalls).toEqual([]);
  });

  test("in-sync line reports unreachable count from diff", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [
        { name: "white", url: "https://white.example" },
        { name: "dead", url: "https://dead.example" },
      ],
      agents: { mawjs: "local" },
    };
    fetchReturn = [
      peer("white", "white", ["mawjs"]),
      peer("dead", "", [], false, "ECONNREFUSED"),
    ];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("(1 peers unreachable)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// header + per-peer rendering
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — header + per-peer rendering", () => {
  test("header includes localNode, peer count, agent count", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [
        { name: "white", url: "https://white.example" },
        { name: "mba", url: "https://mba.example" },
      ],
      agents: { mawjs: "local", homekeeper: "mba" },
    };
    fetchReturn = [
      peer("white", "white", ["mawjs"]),
      peer("mba", "mba", ["homekeeper"]),
    ];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("🔄 Federation Sync");
    expect(joined).toContain("node: oracle-world");
    expect(joined).toContain("2 peers");
    expect(joined).toContain("2 agents");
  });

  test("unreachable peer rendered with yellow ! and error suffix", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "dead", url: "https://dead.example" }],
      agents: {},
    };
    fetchReturn = [peer("dead", "", [], false, "ECONNREFUSED")];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[33m!\x1b[0m");
    expect(joined).toContain("dead");
    expect(joined).toContain("unreachable");
    expect(joined).toContain("ECONNREFUSED");
  });

  test("unreachable peer with NO error → 'unreachable' without trailing dash", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "dead", url: "https://dead.example" }],
      agents: {},
    };
    fetchReturn = [peer("dead", "", [], false)]; // no error field

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("unreachable");
    // Should not include the " — " separator since no error present.
    expect(joined).not.toContain("unreachable —");
  });

  test("reachable peer → green ● + node + oracle count", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs", "pulse"])];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[32m●\x1b[0m");
    expect(joined).toContain("node=white");
    expect(joined).toContain("2 oracles");
  });

  test("adds rendered with green + and target node", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({ dryRun: true }, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[32m+\x1b[0m");
    expect(joined).toContain("pulse");
    expect(joined).toContain("→ white");
  });

  test("conflicts rendered with yellow ~ + 'currently X, peer claims Y'", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[33m~\x1b[0m");
    expect(joined).toContain("mawjs");
    expect(joined).toContain("currently mba");
    expect(joined).toContain("peer claims white");
  });

  test("stale entries rendered with red - + 'no longer hosted on'", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { oldGuy: "white" },
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({ dryRun: true }, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[31m-\x1b[0m");
    expect(joined).toContain("oldGuy");
    expect(joined).toContain("no longer hosted on white");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// conflict gating (no --force)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — conflict gating", () => {
  test("conflict without --force → 'rerun with --force' + exit 2; no save", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(2);
    const joined = outs.join("\n");
    expect(joined).toContain("1 conflict");
    expect(joined).toContain("rerun with");
    expect(joined).toContain("--force");
    expect(saveCalls).toEqual([]);
  });

  test("multiple conflicts → 'N conflicts' (plural)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba", pulse: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs", "pulse"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(2);
    expect(outs.join("\n")).toContain("2 conflicts");
  });

  test("single conflict → 'conflict' (singular)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("1 conflict");
    expect(joined).not.toContain("1 conflicts");
  });

  test("conflict + dryRun → conflict gate skipped, dry-run path runs (exit 0)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ dryRun: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("dry run");
    expect(outs.join("\n")).not.toContain("rerun with");
  });

  test("conflict + check → conflict gate skipped, check path runs (exit 1)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ check: true }, captureSave));

    expect(exitCode).toBe(1);
    expect(outs.join("\n")).toContain("out of sync");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stale gating (no --prune)
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — stale gating", () => {
  test("stale without --prune (with new add too) → stale warning rendered, apply continues", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { oldGuy: "white" },
    };
    // white hosts a new oracle but no longer hosts oldGuy
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    const joined = outs.join("\n");
    expect(joined).toContain("1 stale entry");
    expect(joined).toContain("--prune");
    // The add still applies even though stale doesn't.
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].agents).toEqual({ oldGuy: "white", pulse: "white" });
  });

  test("multiple stale → 'N stale entries' (plural)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { a: "white", b: "white" },
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(outs.join("\n")).toContain("2 stale entries");
  });

  test("single stale → 'stale entry' (singular)", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { a: "white" },
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({}, captureSave));

    const joined = outs.join("\n");
    expect(joined).toContain("1 stale entry");
    expect(joined).not.toContain("1 stale entries");
  });

  test("stale + dryRun → no stale warning rendered", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { a: "white" },
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({ dryRun: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).not.toContain("--prune");
  });

  test("stale + check → no stale warning, check exit 1", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { a: "white" },
    };
    fetchReturn = [peer("white", "white", [])];

    await run(() => cmdFederationSync({ check: true }, captureSave));

    expect(exitCode).toBe(1);
    expect(outs.join("\n")).not.toContain("--prune");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// check mode summary
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — check summary", () => {
  test("check + dirty → '✖ out of sync: N add · N conflict · N stale' + exit 1", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba", oldGuy: "white" },
    };
    fetchReturn = [peer("white", "white", ["mawjs", "pulse"])];

    await run(() => cmdFederationSync({ check: true }, captureSave));

    expect(exitCode).toBe(1);
    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[33m✖\x1b[0m");
    expect(joined).toContain("out of sync");
    expect(joined).toContain("1 add");
    expect(joined).toContain("1 conflict");
    expect(joined).toContain("1 stale");
    expect(saveCalls).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dry-run mode
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — dry run", () => {
  test("dryRun + dirty → 'dry run — no changes written' + exit 0; no save", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({ dryRun: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("dry run — no changes written");
    expect(saveCalls).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// apply path
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — apply path", () => {
  test("simple add → save called with new agents map; '✓ applied 1 change' + exit 0", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs", "pulse"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].agents).toEqual({ mawjs: "local", pulse: "white" });
    const joined = outs.join("\n");
    expect(joined).toContain("applied 1 change");
    expect(joined).toContain("+ agents['pulse'] = 'white'");
    expect(joined).toContain("(from peer 'white')");
  });

  test("default save shim lazily calls config.saveConfig when no save callback is injected", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse"])];

    await run(() => cmdFederationSync({}));

    expect(exitCode).toBe(0);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].agents).toEqual({ pulse: "white" });
    expect(outs.join("\n")).toContain("applied 1 change");
  });

  test("multiple adds → 'applied N changes' (plural) + each msg printed", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
    };
    fetchReturn = [peer("white", "white", ["pulse", "mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    const joined = outs.join("\n");
    expect(joined).toContain("applied 2 changes");
    expect(joined).toContain("+ agents['pulse']");
    expect(joined).toContain("+ agents['mawjs']");
  });

  test("conflict + --force → applies overwrite + save called with new map", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ force: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].agents).toEqual({ mawjs: "white" });
    const joined = outs.join("\n");
    expect(joined).toContain("~ agents['mawjs']");
    expect(joined).toContain("--force");
  });

  test("stale + --prune → entry removed from saved agents map", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local", oldGuy: "white" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({ prune: true }, captureSave));

    expect(exitCode).toBe(0);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].agents).toEqual({ mawjs: "local" });
    const joined = outs.join("\n");
    expect(joined).toContain("- agents['oldGuy']");
    expect(joined).toContain("no longer hosted there");
  });

  test("apply with empty applied list (stale-only, no prune) → 'no changes applied' + exit 0; no save", async () => {
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { oldGuy: "white" },
    };
    fetchReturn = [peer("white", "white", [])]; // stale-only diff, no --prune

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("no changes applied (use --force / --prune)");
    expect(saveCalls).toEqual([]);
  });

  test("conflict-only without --force (after stale gate already-clean) does not reach apply", async () => {
    // Sanity guard: conflict gate must precede apply, so save is not called.
    configStore = {
      node: "oracle-world",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "mba" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(exitCode).toBe(2);
    expect(saveCalls).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// integration: fetchPeerIdentities receives the namedPeers verbatim
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFederationSync — fetch wiring", () => {
  test("fetchPeerIdentities is called once with the namedPeers from config", async () => {
    const peers = [
      { name: "white", url: "https://white.example" },
      { name: "mba", url: "https://mba.example" },
    ];
    configStore = { node: "oracle-world", namedPeers: peers, agents: { mawjs: "local" } };
    fetchReturn = [
      peer("white", "white", ["mawjs"]),
      peer("mba", "mba", []),
    ];

    await run(() => cmdFederationSync({}, captureSave));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].peers).toEqual(peers);
  });

  test("missing node defaults to 'local' in the text-mode header", async () => {
    configStore = {
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: { mawjs: "local" },
    };
    fetchReturn = [peer("white", "white", ["mawjs"])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(outs.join("\n")).toContain("node: local");
  });

  test("missing agents defaults to {} (header reports 0 agents)", async () => {
    configStore = {
      node: "white",
      namedPeers: [{ name: "mba", url: "https://mba.example" }],
    };
    fetchReturn = [peer("mba", "mba", [])];

    await run(() => cmdFederationSync({}, captureSave));

    expect(outs.join("\n")).toContain("0 agents");
  });

  test("--peers both can feed ephemeral scout peers and preserve scout warnings in JSON", async () => {
    configStore = { node: "white", namedPeers: [], agents: {} };
    fetchReturn = [peer("scout-node", "scout-node", [])];

    await run(() => cmdFederationSync({ json: true, peers: "both" }, captureSave, {
      resolvePeerSources: async () => ({
        mode: "both",
        warnings: ["scout unavailable (daemon_unreachable)"],
        peers: [{ name: "scout-node", url: "https://scout.example", source: "scout" }],
      }),
    }));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].peers).toEqual([{ name: "scout-node", url: "https://scout.example" }]);
    const parsed = JSON.parse(outs[0]);
    expect(parsed.peerWarnings).toEqual(["scout unavailable (daemon_unreachable)"]);
  });

  test("--peers both text mode warns and exits cleanly when no config or scout peers exist", async () => {
    configStore = { node: "white", namedPeers: [], agents: {} };

    await run(() => cmdFederationSync({ peers: "both" }, captureSave, {
      resolvePeerSources: async () => ({
        mode: "both",
        warnings: ["scout unavailable (daemon_unreachable)"],
        peers: [],
      }),
    }));

    const joined = outs.join("\n");
    expect(exitCode).toBe(0);
    expect(joined).toContain("scout unavailable");
    expect(joined).toContain("no peers configured or discovered — nothing to sync");
    expect(fetchCalls).toEqual([]);
  });
});
