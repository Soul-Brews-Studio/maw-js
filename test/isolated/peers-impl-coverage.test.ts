import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

type ProbeShape = {
  node: string | null;
  error?: { code: string; message: string; at: string };
  nickname?: string | null;
  identity?: { oracle: string; node: string };
  pubkey?: string;
};

type TofuDecision = {
  kind: "match" | "mismatch" | "tofu-bootstrap" | "legacy-first-contact" | "legacy-after-pinned";
  alias?: string;
  message?: string;
  cached?: string;
  observed?: string;
};

describe("src/lib/peers impl focused coverage", () => {
  const storePath = import.meta.resolve("../../src/lib/peers/store.ts");
  const probePath = import.meta.resolve("../../src/lib/peers/probe.ts");
  const tofuPath = import.meta.resolve("../../src/lib/peers/tofu.ts");

  let implModule: typeof import("../../src/lib/peers/impl");
  let peers: Record<string, any> = {};
  let probeResult: ProbeShape = { node: "probe-node" };
  let probeCalls: string[] = [];
  let tofuCalls: Array<{ alias: string; kind: string }> = [];
  let forgetCalls: string[] = [];
  let forgetOutcome: "cleared" | "no-pubkey" | "not-found" = "cleared";
  let mutateDropAlias: string | null = null;
  let evaluateDecision: TofuDecision = { kind: "match" };

  beforeAll(async () => {
    mock.module(storePath, () => ({
      loadPeers: () => ({ peers }),
      mutatePeers: (mutate: (data: { peers: Record<string, any> }) => void) => {
        const data = { peers: { ...peers } };
        if (mutateDropAlias) delete data.peers[mutateDropAlias];
        mutate(data);
        peers = data.peers;
      },
    }));

    mock.module(probePath, () => ({
      probePeer: async (url: string) => {
        probeCalls.push(url);
        return probeResult;
      },
    }));

    mock.module(tofuPath, () => ({
      evaluatePeerIdentity: (alias: string, existing: any, observed: string | undefined) => ({
        ...evaluateDecision,
        alias,
        cached: evaluateDecision.cached ?? existing?.pubkey,
        observed: evaluateDecision.observed ?? observed,
      }),
      applyTofuDecision: (decision: { alias?: string; kind: string }) => {
        tofuCalls.push({ alias: decision.alias ?? "unknown", kind: decision.kind });
      },
      forgetPeerPubkey: (alias: string) => {
        forgetCalls.push(alias);
        return forgetOutcome;
      },
      PeerPubkeyMismatchError: class extends Error {
        alias: string;
        cached: string;
        observed: string;
        constructor(alias: string, cached: string, observed: string) {
          super(`peer pubkey changed for ${alias}: ${cached} → ${observed}`);
          this.alias = alias;
          this.cached = cached;
          this.observed = observed;
        }
      },
    }));

    implModule = await import("../../src/lib/peers/impl");
  });

  beforeEach(() => {
    peers = {};
    probeResult = { node: "probe-node" };
    probeCalls = [];
    tofuCalls = [];
    forgetCalls = [];
    forgetOutcome = "cleared";
    mutateDropAlias = null;
    evaluateDecision = { kind: "match" };
  });

  test("cmdAdd refuses authenticated pubkey mismatch before mutating cache", async () => {
    probeResult = {
      node: "remote-node",
      pubkey: "probe-key",
      error: { code: "UNKNOWN", message: "warn", at: "2026-05-18T00:00:00.000Z" },
    };

    const result = await implModule.cmdAdd({
      alias: "alice",
      url: "http://alice.local:3210",
      node: "operator-node",
      pubkey: "handshake-key",
    });

    expect(result.overwrote).toBe(false);
    expect(result.peer).toMatchObject({
      url: "http://alice.local:3210",
      node: "operator-node",
      lastSeen: null,
    });
    expect(result.probeError?.message).toBe("warn");
    expect(result.pubkeyMismatch?.message).toContain("handshake-key → probe-key");
    expect(peers).toEqual({});
    expect(tofuCalls).toEqual([]);
  });

  test("cmdAdd stamps authenticated identity, probe errors, TOFU bootstrap, and symmetric flags", async () => {
    probeResult = {
      node: null,
      error: { code: "TIMEOUT", message: "slow", at: "2026-05-18T00:00:00.000Z" },
    };
    evaluateDecision = { kind: "tofu-bootstrap" };

    const result = await implModule.cmdAdd({
      alias: "bob",
      url: "https://bob.example",
      pubkey: "auth-pubkey",
      identity: { oracle: "bob-oracle", node: "bob-node" },
      markSymmetricCheck: true,
      oneWay: false,
    });

    expect(result.overwrote).toBe(false);
    expect(result.probeError?.code).toBe("TIMEOUT");
    expect(result.peer).toMatchObject({
      url: "https://bob.example",
      node: null,
      lastSeen: null,
      lastError: { message: "slow" },
      pubkey: "auth-pubkey",
      identity: { oracle: "bob-oracle", node: "bob-node" },
      oneWay: false,
    });
    expect(result.peer.pubkeyFirstSeen).toBeString();
    expect(result.peer.lastSymmetricCheck).toBe(result.peer.addedAt);
    expect(peers.bob).toEqual(result.peer);
    expect(tofuCalls).toEqual([{ alias: "bob", kind: "tofu-bootstrap" }]);
  });

  test("cmdAdd preserves cached identity, pubkey, and prior symmetric state on re-add", async () => {
    peers.carol = {
      url: "http://old-carol",
      node: "old-node",
      identity: { oracle: "cached-oracle", node: "cached-node" },
      pubkey: "cached-key",
      pubkeyFirstSeen: "first-seen",
      lastSymmetricCheck: "previous-check",
      oneWay: true,
      addedAt: "old-added",
      lastSeen: "old-seen",
    };
    probeResult = { node: "new-node" };

    const result = await implModule.cmdAdd({ alias: "carol", url: "http://new-carol" });

    expect(result.overwrote).toBe(true);
    expect(result.peer).toMatchObject({
      url: "http://new-carol",
      node: "new-node",
      identity: { oracle: "cached-oracle", node: "cached-node" },
      pubkey: "cached-key",
      pubkeyFirstSeen: "first-seen",
      lastSymmetricCheck: "previous-check",
      oneWay: true,
    });
    expect(peers.carol).toEqual(result.peer);
  });

  test("cmdAdd refuses TOFU mismatches without overwriting an existing peer", async () => {
    peers.frank = {
      url: "http://old-frank",
      node: "old-node",
      pubkey: "cached-key",
      addedAt: "old-added",
      lastSeen: "old-seen",
    };
    probeResult = { node: "new-node", pubkey: "observed-key" };
    evaluateDecision = { kind: "mismatch", cached: "cached-key", observed: "observed-key" };

    const result = await implModule.cmdAdd({ alias: "frank", url: "http://new-frank" });

    expect(result).toMatchObject({
      alias: "frank",
      overwrote: true,
      peer: { url: "http://old-frank", node: "old-node" },
    });
    expect(result.pubkeyMismatch?.message).toContain("cached-key → observed-key");
    expect(peers.frank.url).toBe("http://old-frank");
    expect(tofuCalls).toEqual([]);
  });

  test("cmdProbe covers missing, error, success refresh, explicit nickname clear, and remove-race", async () => {
    await expect(implModule.cmdProbe("missing")).rejects.toThrow('peer "missing" not found');

    peers.dave = {
      url: "http://dave",
      node: "seed-node",
      nickname: "seed-nick",
      identity: { oracle: "seed", node: "seed-node" },
      addedAt: "x",
      lastSeen: "keep-seen",
    };
    probeResult = {
      node: null,
      nickname: null,
      error: { code: "REFUSED", message: "closed", at: "2026-05-18T00:00:00.000Z" },
    };

    const failed = await implModule.cmdProbe("dave");
    expect(failed).toMatchObject({ alias: "dave", node: "seed-node", ok: false, error: { message: "closed" } });
    expect(peers.dave).toMatchObject({ nickname: "seed-nick", lastSeen: "keep-seen", lastError: { message: "closed" } });

    probeResult = { node: "fresh-node", nickname: null, identity: { oracle: "fresh", node: "fresh-node" } };
    const refreshed = await implModule.cmdProbe("dave");
    expect(refreshed).toMatchObject({ alias: "dave", node: "fresh-node", ok: true });
    expect(peers.dave.node).toBe("fresh-node");
    expect(peers.dave.nickname).toBeUndefined();
    expect(peers.dave.lastError).toBeUndefined();
    expect(peers.dave.identity).toEqual({ oracle: "fresh", node: "fresh-node" });

    peers.race = { url: "http://race", node: "before-race", addedAt: "x", lastSeen: null };
    mutateDropAlias = "race";
    probeResult = { node: "after-race" };
    const raced = await implModule.cmdProbe("race");
    expect(raced).toMatchObject({ alias: "race", node: "after-race", ok: true });
    expect(peers.race).toBeUndefined();
    expect(tofuCalls.map((call) => call.kind)).toEqual(["match", "match", "match"]);
  });

  test("cmdProbe mismatch skips mutation and cmdForget validates before dynamic tofu import", async () => {
    peers.erin = {
      url: "http://erin",
      node: "old-node",
      pubkey: "cached-key",
      addedAt: "x",
      lastSeen: "old-seen",
    };
    probeResult = {
      node: "rotated-node",
      pubkey: "new-key",
      error: { code: "UNKNOWN", message: "changed", at: "2026-05-18T00:00:00.000Z" },
    };
    evaluateDecision = { kind: "mismatch", cached: "cached-key", observed: "new-key" };

    const mismatch = await implModule.cmdProbe("erin");
    expect(mismatch).toMatchObject({ alias: "erin", url: "http://erin", node: "rotated-node", ok: false });
    expect(mismatch.pubkeyMismatch?.message).toContain("cached-key → new-key");
    expect(peers.erin.lastSeen).toBe("old-seen");
    expect(peers.erin.lastError).toBeUndefined();

    await expect(implModule.cmdForget("Bad_alias")).rejects.toThrow("invalid alias");
    expect(forgetCalls).toEqual([]);
    forgetOutcome = "no-pubkey";
    expect(await implModule.cmdForget("erin")).toBe("no-pubkey");
    expect(forgetCalls).toEqual(["erin"]);
  });
});
