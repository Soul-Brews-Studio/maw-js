import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";

import {
  clearStaleTmp,
  emptyStore,
  loadPeers,
  mutatePeers,
  peersPath,
  savePeers,
  type PeersFile,
} from "../../src/lib/peers/store";

type Trigger = {
  on: string;
  action: string;
  timeout?: number;
};

type FireResult = { ok: boolean };

const idleTimers = new Map<string, number>();
const agentPrevState = new Map<string, "busy" | "idle">();
let triggers: Trigger[] = [];
let fireResults: FireResult[] = [];
let fireCalls: Array<{ event: string; ctx: Record<string, string> }> = [];

mock.module(import.meta.resolve("../../src/core/runtime/triggers-engine.ts"), () => ({
  fire: async (event: string, ctx: Record<string, string>) => {
    fireCalls.push({ event, ctx });
    return fireResults;
  },
  getTriggers: () => triggers,
  idleTimers,
  agentPrevState,
}));

const { checkIdleTriggers, markAgentActive } = await import("../../src/core/runtime/triggers-idle.ts?peers-store-triggers-idle-more-coverage");

const originalPeersFile = process.env.PEERS_FILE;
const originalHome = process.env.HOME;
const originalMawHome = process.env.MAW_HOME;
const originalMawStateDir = process.env.MAW_STATE_DIR;
const originalDateNow = Date.now;

let tempDir = "";
let peersFile = "";

function samplePeer(url: string, node: string | null = null): PeersFile["peers"][string] {
  return {
    url,
    node,
    addedAt: "2026-05-18T00:00:00.000Z",
    lastSeen: null,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "maw-peers-store-idle-"));
  peersFile = join(tempDir, "nested", "peers.json");
  process.env.PEERS_FILE = peersFile;

  triggers = [];
  fireResults = [];
  fireCalls = [];
  idleTimers.clear();
  agentPrevState.clear();
  Date.now = originalDateNow;
});

afterEach(() => {
  Date.now = originalDateNow;
  if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = originalPeersFile;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalMawStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalMawStateDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("src/lib/peers/store focused branches", () => {
  test("state path is primary and legacy home peers migrate forward on mutation", () => {
    delete process.env.PEERS_FILE;
    delete process.env.MAW_HOME;
    process.env.HOME = join(tempDir, "home");
    process.env.MAW_STATE_DIR = join(tempDir, "state");

    const legacyDir = join(process.env.HOME, ".maw");
    const legacyFile = join(legacyDir, "peers.json");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      peers: { alpha: samplePeer("http://legacy-alpha:3210", "legacy-node") },
    }));

    expect(peersPath()).toBe(join(process.env.MAW_STATE_DIR, "peers.json"));
    expect(loadPeers().peers.alpha.node).toBe("legacy-node");

    const migrated = mutatePeers((data) => {
      data.peers.beta = samplePeer("http://state-beta:3210", "state-node");
    });

    expect(Object.keys(migrated.peers).sort()).toEqual(["alpha", "beta"]);
    expect(JSON.parse(readFileSync(peersPath(), "utf-8")).peers.alpha.node).toBe("legacy-node");
    expect(JSON.parse(readFileSync(legacyFile, "utf-8")).peers.beta).toBeUndefined();
  });

  test("loadPeers handles missing, unreadable, missing-peers, corrupt, and invalid-shape stores", () => {
    expect(peersPath()).toBe(peersFile);
    expect(emptyStore()).toEqual({ version: 1, peers: {} });
    expect(loadPeers()).toEqual({ version: 1, peers: {} });

    mkdirSync(peersFile, { recursive: true });
    expect(loadPeers()).toEqual({ version: 1, peers: {} });
    rmSync(peersFile, { recursive: true, force: true });

    writeFileSync(peersFile, JSON.stringify({ version: 1 }));
    expect(loadPeers()).toEqual({ version: 1, peers: {} });

    const originalConsoleError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      writeFileSync(peersFile, "{not-json");
      expect(loadPeers()).toEqual({ version: 1, peers: {} });
      expect(existsSync(peersFile)).toBe(false);

      savePeers({ version: 1, peers: {} });
      writeFileSync(peersFile, JSON.stringify({ version: 1, peers: [] }));
      expect(loadPeers()).toEqual({ version: 1, peers: {} });
      expect(existsSync(peersFile)).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }

    expect(errors.join("\n")).toContain("failed to parse");
    expect(readdirSync(dirname(peersFile)).some((name) => name.startsWith("peers.json.corrupt-"))).toBe(true);
  });

  test("savePeers and mutatePeers write atomically, clean stale tmp files, and recover malformed current contents", () => {
    savePeers({
      version: 1,
      peers: {
        alpha: samplePeer("http://alpha.local:3210", "alpha-node"),
      },
    });

    expect(existsSync(`${peersFile}.tmp`)).toBe(false);
    expect(existsSync(`${peersFile}.lock`)).toBe(false);
    expect(readFileSync(peersFile, "utf-8")).toContain("alpha-node");

    writeFileSync(`${peersFile}.tmp`, "stale partial write");
    expect(loadPeers().peers.alpha).toMatchObject({ url: "http://alpha.local:3210", node: "alpha-node" });
    expect(existsSync(`${peersFile}.tmp`)).toBe(false);

    writeFileSync(peersFile, JSON.stringify({ version: 1, peers: [] }));
    const recovered = mutatePeers((data) => {
      data.peers.beta = samplePeer("http://beta.local:3210");
    });

    expect(Object.keys(recovered.peers)).toEqual(["beta"]);
    expect(loadPeers().peers.beta.url).toBe("http://beta.local:3210");
    expect(existsSync(`${peersFile}.lock`)).toBe(false);
  });

  test("clearStaleTmp is best-effort when stale tmp removal itself fails", () => {
    mkdirSync(`${peersFile}.tmp`, { recursive: true });

    expect(() => clearStaleTmp()).not.toThrow();
    expect(existsSync(`${peersFile}.tmp`)).toBe(true);
  });
});

describe("src/core/runtime/triggers-idle focused branches", () => {
  test("markAgentActive records busy state and checkIdleTriggers no-ops when no triggers exist", async () => {
    const now = 1_779_000_000_000;
    Date.now = () => now;

    markAgentActive("oracle");

    expect(idleTimers.get("oracle")).toBe(now);
    expect(agentPrevState.get("oracle")).toBe("busy");
    expect(await checkIdleTriggers()).toEqual([]);
    expect(fireCalls).toEqual([]);
  });

  test("checkIdleTriggers skips non-busy agents, triggers without timeouts, and agents below timeout", async () => {
    const now = 1_779_000_100_000;
    Date.now = () => now;
    triggers = [
      { on: "agent-idle", action: "echo no-timeout" },
      { on: "agent-idle", action: "echo too-young", timeout: 30 },
    ];
    fireResults = [{ ok: true }];
    idleTimers.set("already-idle", now - 60_000);
    agentPrevState.set("already-idle", "idle");
    idleTimers.set("too-young", now - 10_000);
    agentPrevState.set("too-young", "busy");

    expect(await checkIdleTriggers()).toEqual([]);
    expect(fireCalls).toEqual([]);
    expect(idleTimers.has("too-young")).toBe(true);
    expect(agentPrevState.get("too-young")).toBe("busy");
  });

  test("checkIdleTriggers records a fired idle transition and clears its timer after a successful fire", async () => {
    const now = 1_779_000_200_000;
    Date.now = () => now;
    triggers = [{ on: "agent-idle", action: "echo idle", timeout: 5 }];
    fireResults = [{ ok: true }];
    idleTimers.set("done-agent", now - 6_000);
    agentPrevState.set("done-agent", "busy");

    expect(await checkIdleTriggers()).toEqual(["done-agent"]);
    expect(fireCalls).toEqual([{ event: "agent-idle", ctx: { agent: "done-agent" } }]);
    expect(agentPrevState.get("done-agent")).toBe("idle");
    expect(idleTimers.has("done-agent")).toBe(false);
  });

  test("checkIdleTriggers leaves busy state and timer intact when fire returns no successful result", async () => {
    const now = 1_779_000_300_000;
    Date.now = () => now;
    triggers = [{ on: "agent-idle", action: "exit 1", timeout: 5 }];
    fireResults = [{ ok: false }];
    idleTimers.set("retry-agent", now - 6_000);
    agentPrevState.set("retry-agent", "busy");

    expect(await checkIdleTriggers()).toEqual([]);
    expect(fireCalls).toEqual([{ event: "agent-idle", ctx: { agent: "retry-agent" } }]);
    expect(agentPrevState.get("retry-agent")).toBe("busy");
    expect(idleTimers.get("retry-agent")).toBe(now - 6_000);
  });
});
