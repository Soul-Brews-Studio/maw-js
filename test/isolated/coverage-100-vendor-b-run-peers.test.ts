import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---- run/impl.ts seams ----------------------------------------------------

type ResolveResult =
  | null
  | { type: "error"; detail: string; hint?: string }
  | { type: "peer"; peerUrl: string; target: string; node: string }
  | { type: "local"; target: string };

let resolveResult: ResolveResult = { type: "local", target: "%1" };
let curlResult: { ok: boolean; status?: number; data?: { ok?: boolean; error?: string; target?: string } } = { ok: true, data: { ok: true } };
let literalSends: Array<{ target: string; text: string }> = [];
let keySends: Array<{ target: string; key: string }> = [];
let logs: string[] = [];

mock.module("maw-js/config", () => ({ loadConfig: () => ({ node: "local" }) }));
mock.module("maw-js/sdk", () => ({
  listSessions: async () => [{ name: "s", windows: [] }],
  resolveTarget: () => resolveResult,
  curlFetch: async () => curlResult,
  hostExec: async () => "",
  Tmux: class {
    async sendKeysLiteral(target: string, text: string) { literalSends.push({ target, text }); }
    async sendKeys(target: string, key: string) { keySends.push({ target, key }); }
  },
}));
mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: async (target: string) => `resolved:${target}`,
}));

const runImpl = await import("../../src/vendor/mpr-plugins/run/impl.ts?coverage-100-vendor-b-run");

const originalLog = console.log;

beforeEach(() => {
  resolveResult = { type: "local", target: "%1" };
  curlResult = { ok: true, data: { ok: true } };
  literalSends = [];
  keySends = [];
  logs = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
});

describe("coverage-100 vendor-b run impl gaps", () => {
  test("parseRunArgs preserves command flags and rejects missing targets", () => {
    expect(runImpl.parseRunArgs(["pane", "echo", "--flag"])).toEqual({ target: "pane", text: "echo --flag" });
    expect(runImpl.parseRunArgs(["pane"])).toEqual({ target: "pane", text: "" });
    expect(() => runImpl.parseRunArgs(["--only-flag"])).toThrow("usage: maw run");
  });

  test("cmdRun reports unresolved targets and resolver errors with hints", async () => {
    await expect(runImpl.cmdRun({ target: "", text: "pwd" })).rejects.toThrow("usage: maw run");

    resolveResult = null;
    await expect(runImpl.cmdRun({ target: "ghost", text: "pwd" })).rejects.toThrow("could not resolve target: ghost");

    resolveResult = { type: "error", detail: "ambiguous target", hint: "use exact" };
    await expect(runImpl.cmdRun({ target: "neo", text: "pwd" })).rejects.toThrow("ambiguous target — use exact");
  });

  test("cmdRun covers peer failure, peer success fallback target, and local literal send", async () => {
    resolveResult = { type: "peer", node: "remote", peerUrl: "https://remote.example", target: "pane-1" };
    curlResult = { ok: false, status: 502, data: {} };
    await expect(runImpl.cmdRun({ target: "remote", text: "ls" })).rejects.toThrow("peer run failed (remote https://remote.example): HTTP 502");

    curlResult = { ok: true, data: { ok: true } };
    await runImpl.cmdRun({ target: "remote", text: "x".repeat(205) });
    expect(logs.at(-1)).toContain("remote → pane-1");
    expect(logs.at(-1)).toContain("…");

    resolveResult = { type: "local", target: "%2" };
    await runImpl.cmdRun({ target: "local", text: "echo hi" });
    expect(literalSends).toEqual([{ target: "resolved:%2", text: "echo hi" }]);
    expect(keySends).toContainEqual({ target: "resolved:%2", key: "Enter" });
  });
});

// ---- peers/impl.ts seams --------------------------------------------------

type Peer = Record<string, any>;
const peerStore: { peers: Record<string, Peer> } = { peers: {} };
let probe: any = { node: "node-a", pubkey: "pk-a", identity: { node: "node-a" }, nickname: "nick" };
let tofuKind: "match" | "tofu-bootstrap" | "mismatch" | "legacy" = "match";
let appliedTofu: string[] = [];

const peersStorePath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/store");
const peersProbePath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/probe");
const peersTofuPath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/tofu");

mock.module(peersStorePath, () => ({
  loadPeers: () => peerStore,
  mutatePeers: (fn: (data: typeof peerStore) => void) => fn(peerStore),
  getStaleTtlMs: () => 1_000,
  isStale: () => false,
  staleAgeMs: () => null,
}));
mock.module(peersProbePath, () => ({ probePeer: async () => probe }));
mock.module(peersTofuPath, () => ({
  PeerPubkeyMismatchError: class PeerPubkeyMismatchError extends Error {
    constructor(alias: string, cached: string, observed: string) {
      super(`peer pubkey changed for ${alias}: ${cached} -> ${observed}`);
    }
  },
  evaluatePeerIdentity: (_alias: string, existing: Peer | undefined, observed: string | undefined) => {
    if (tofuKind === "mismatch") return { kind: "mismatch", cached: existing?.pubkey ?? "cached", observed: observed ?? "observed" };
    if (tofuKind === "tofu-bootstrap") return { kind: "tofu-bootstrap", observed };
    return { kind: tofuKind };
  },
  applyTofuDecision: (decision: { kind: string }) => appliedTofu.push(decision.kind),
  forgetPeerPubkey: async (alias: string) => alias === "known" ? "cleared" : "not-found",
}));

const peersImpl = await import("../../src/vendor/mpr-plugins/peers/impl.ts?coverage-100-vendor-b-peers");

beforeEach(() => {
  peerStore.peers = {};
  probe = { node: "node-a", pubkey: "pk-a", identity: { node: "node-a" }, nickname: "nick" };
  tofuKind = "match";
  appliedTofu = [];
});

describe("coverage-100 vendor-b peers impl gaps", () => {
  test("cmdAdd stamps TOFU bootstrap pubkeys and falls back to cached identity", async () => {
    tofuKind = "tofu-bootstrap";
    probe = { node: "fresh-node", pubkey: "fresh-pk", nickname: null };
    const fresh = await peersImpl.cmdAdd({ alias: "fresh", url: "https://fresh.example" });
    expect(fresh.peer.pubkey).toBe("fresh-pk");
    expect(fresh.peer.pubkeyFirstSeen).toBeString();
    expect(appliedTofu).toEqual(["tofu-bootstrap"]);

    peerStore.peers.cached = { url: "https://old.example", node: "old", identity: { node: "cached-id" } };
    tofuKind = "match";
    probe = { node: "cached-node", pubkey: undefined, identity: undefined, nickname: undefined };
    const fallback = await peersImpl.cmdAdd({ alias: "cached", url: "https://new.example" });
    expect(fallback.peer.identity).toEqual({ node: "cached-id" });
  });

  test("cmdProbe records probe errors and cmdForget validates aliases", async () => {
    peerStore.peers.slow = { url: "https://slow.example", node: "old-node" };
    probe = { node: null, error: { kind: "timeout", message: "slow" } };

    const result = await peersImpl.cmdProbe("slow");

    expect(result).toMatchObject({ alias: "slow", ok: false, error: { kind: "timeout", message: "slow" } });
    expect(peerStore.peers.slow.lastError).toEqual({ kind: "timeout", message: "slow" });
    await expect(peersImpl.cmdForget("Bad Alias")).rejects.toThrow("invalid alias");
    await expect(peersImpl.cmdForget("known")).resolves.toBe("cleared");
  });
});
