import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

type ProbeShape = {
  node: string | null;
  error?: { code: string; message: string; at: string };
  nickname?: string | null;
  identity?: Record<string, unknown>;
  pubkey?: string;
};

describe("pair/internal peers impl coverage", () => {
  const storePath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/store.ts");
  const probePath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/probe.ts");
  const tofuPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/tofu.ts");

  let implModule: typeof import("../../src/vendor/mpr-plugins/pair/internal/peers-impl");
  let peers: Record<string, any> = {};
  let probeResult: ProbeShape = { node: "probe-node" };
  let probeCalls: string[] = [];
  let tofuCalls: Array<{ alias: string; kind: string }> = [];
  let forgetOutcome: "cleared" | "no-pubkey" | "not-found" = "cleared";
  let mutateDropAlias: string | null = null;
  let evaluateDecision: {
    kind: "match" | "mismatch" | "tofu-bootstrap" | "legacy-first-contact" | "legacy-after-pinned";
    cached?: string;
    observed?: string;
  } = { kind: "match" };

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
      evaluatePeerIdentity: (_alias: string, existing: any, observed: string | undefined) => ({
        ...evaluateDecision,
        cached: existing?.pubkey,
        observed,
      }),
      applyTofuDecision: (decision: { alias?: string; kind: string }) => {
        tofuCalls.push({ alias: decision.alias ?? "unknown", kind: decision.kind });
      },
      forgetPeerPubkey: (_alias: string) => forgetOutcome,
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

    implModule = await import("../../src/vendor/mpr-plugins/pair/internal/peers-impl");
  });

  beforeEach(() => {
    peers = {};
    probeResult = { node: "probe-node" };
    probeCalls = [];
    tofuCalls = [];
    forgetOutcome = "cleared";
    mutateDropAlias = null;
    evaluateDecision = { kind: "match" };
  });

  test("cmdProbe rejects missing aliases and cmdForget validates alias format", async () => {
    await expect(implModule.cmdProbe("missing")).rejects.toThrow('peer "missing" not found');
    await expect(implModule.cmdForget("Bad_alias")).rejects.toThrow("invalid alias");
  });

  test("cmdProbe records probe errors without clobbering prior success fields", async () => {
    peers.bob = {
      url: "http://bob",
      node: "seed-node",
      nickname: "seed-nick",
      identity: { oracle: "seed", node: "seed-node" },
      addedAt: "x",
      lastSeen: "keep-seen",
    };
    probeResult = {
      node: null,
      error: { code: "UNKNOWN", message: "down", at: "2026-05-18T00:00:00.000Z" },
      nickname: null,
    };

    const result = await implModule.cmdProbe("bob");

    expect(result).toMatchObject({
      alias: "bob",
      url: "http://bob",
      node: "seed-node",
      ok: false,
      error: { message: "down" },
    });
    expect(peers.bob).toMatchObject({
      node: "seed-node",
      nickname: "seed-nick",
      identity: { oracle: "seed", node: "seed-node" },
      lastSeen: "keep-seen",
      lastError: { message: "down" },
    });
    expect(probeCalls).toEqual(["http://bob"]);
    expect(tofuCalls).toEqual([{ alias: "unknown", kind: "match" }]);
  });

  test("cmdProbe clears nickname on explicit null, preserves cached identity, and survives remove-race", async () => {
    peers.bob = {
      url: "http://bob",
      node: "old-node",
      nickname: "old-nick",
      identity: { oracle: "persist-me", node: "old-node" },
      addedAt: "x",
      lastSeen: "old-seen",
    };
    probeResult = { node: "fresh-node", nickname: null };

    const refreshed = await implModule.cmdProbe("bob");
    expect(refreshed.ok).toBe(true);
    expect(peers.bob.node).toBe("fresh-node");
    expect(peers.bob.nickname).toBeUndefined();
    expect(peers.bob.identity).toEqual({ oracle: "persist-me", node: "old-node" });

    peers.carol = {
      url: "http://carol",
      node: "carol-node",
      addedAt: "x",
      lastSeen: "seed",
    };
    mutateDropAlias = "carol";
    probeResult = { node: "after-race" };

    const raced = await implModule.cmdProbe("carol");
    expect(raced).toMatchObject({ alias: "carol", url: "http://carol", node: "after-race", ok: true });
    expect(peers.carol).toBeUndefined();
  });

  test("cmdProbe mismatch returns pubkeyMismatch and skips mutation", async () => {
    peers.alice = {
      url: "http://alice",
      node: "old-node",
      pubkey: "cached-key",
      addedAt: "x",
      lastSeen: "seed",
    };
    evaluateDecision = { kind: "mismatch", cached: "cached-key", observed: "new-key" };
    probeResult = {
      node: "rotated-node",
      error: { code: "UNKNOWN", message: "changed", at: "2026-05-18T00:00:00.000Z" },
      pubkey: "new-key",
    };

    const result = await implModule.cmdProbe("alice");

    expect(result.ok).toBe(false);
    expect(result.node).toBe("rotated-node");
    expect(result.pubkeyMismatch?.message).toContain("peer pubkey changed for alice");
    expect(peers.alice.lastSeen).toBe("seed");
    expect(peers.alice.lastError).toBeUndefined();
    expect(tofuCalls).toEqual([]);
  });

  test("list/info/remove/forget/formatList cover empty and populated output paths", async () => {
    expect(implModule.formatList([])).toBe("no peers");

    peers = {
      b: { url: "http://b", node: "node-b", nickname: "bee", addedAt: "x", lastSeen: "2026-01-02" },
      a: { url: "http://a", node: null, addedAt: "x", lastSeen: null },
    };

    const rows = implModule.cmdList();
    expect(rows.map((row) => row.alias)).toEqual(["a", "b"]);
    expect(implModule.cmdInfo("a")).toEqual({ alias: "a", ...peers.a });
    expect(implModule.cmdInfo("missing")).toBeNull();
    expect(implModule.cmdRemove("a")).toBe(true);
    expect(implModule.cmdRemove("missing")).toBe(false);

    forgetOutcome = "no-pubkey";
    expect(await implModule.cmdForget("b")).toBe("no-pubkey");

    const formatted = implModule.formatList(rows);
    expect(formatted).toContain("alias");
    expect(formatted).toContain("nickname");
    expect(formatted).toContain("a      http://a  -       -         -");
    expect(formatted).toContain("b      http://b  node-b  bee       2026-01-02");
  });
});
