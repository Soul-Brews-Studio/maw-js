import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as appDuplicate from "../../src/lib/peers/duplicate-detect";
import * as vendorDuplicate from "../../src/vendor/mpr-plugins/peers/duplicate-detect";

type PeerShape = {
  url: string;
  node: string | null;
  addedAt: string;
  lastSeen: string | null;
  identity?: { oracle: string; node: string };
  pubkey?: string;
  pubkeyFirstSeen?: string;
  nickname?: string | null;
  lastError?: { code: string; message: string; at: string };
  oneWay?: boolean;
  lastSymmetricCheck?: string;
};

type ProbeShape = {
  node: string | null;
  nickname?: string | null;
  pubkey?: string;
  identity?: { oracle: string; node: string };
  error?: { code: string; message: string; at: string };
};

function peer(overrides: Partial<PeerShape> = {}): PeerShape {
  return {
    url: "http://example.local:3456",
    node: "example",
    addedAt: "2026-05-18T00:00:00.000Z",
    lastSeen: null,
    ...overrides,
  };
}

const duplicateModules = [
  ["src", appDuplicate],
  ["vendor", vendorDuplicate],
] as const;

describe.each(duplicateModules)("%s peers duplicate detection exports", (_label, mod) => {
  test("skips legacy or malformed identities and reports stable sorted duplicate claims", () => {
    const duplicates = mod.findDuplicateIdentities({
      legacy: peer({ identity: undefined }),
      missingOracle: peer({ identity: { oracle: "", node: "m5" } }),
      missingNode: peer({ identity: { oracle: "mawjs", node: "" } }),
      zed: peer({ url: "http://zed", identity: { oracle: "zed", node: "node" } }),
      alphaOne: peer({ url: "http://alpha-1", identity: { oracle: "mawjs", node: "alpha" } }),
      alphaTwo: peer({ url: "http://alpha-2", identity: { oracle: "mawjs", node: "alpha" } }),
    }, { oracle: "local", node: "self" });

    expect(duplicates).toEqual([
      {
        key: "mawjs:alpha",
        claimants: [
          { alias: "alphaOne", url: "http://alpha-1" },
          { alias: "alphaTwo", url: "http://alpha-2" },
        ],
      },
    ]);
  });

  test("includes local identity collisions, formats URLs, and logs boot warnings without throwing", () => {
    const logs: string[] = [];
    const duplicates = mod.warnDuplicatesAtBoot({
      local: { oracle: "mawjs", node: "m5" },
      peers: {
        selfAlias: peer({ url: "http://m5-alias", identity: { oracle: "mawjs", node: "m5" } }),
        other: peer({ url: "http://other", identity: { oracle: "mawjs", node: "other" } }),
      },
      log: (msg) => logs.push(msg),
    });

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.claimants).toEqual([
      { alias: "<local>" },
      { alias: "selfAlias", url: "http://m5-alias" },
    ]);
    expect(mod.formatDuplicate(duplicates[0]!)).toBe(
      'duplicate <oracle>:<node> claim "mawjs:m5" — <local>, selfAlias (http://m5-alias)',
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("\x1b[33m⚠ duplicate <oracle>:<node> claim");
    expect(logs[1]).toContain("maw peers remove <alias>");
  });

  test("sorts multiple duplicate groups and uses the default boot logger", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };

    try {
      const duplicates = mod.warnDuplicatesAtBoot({
        peers: {
          zOne: peer({ url: "http://z-1", identity: { oracle: "zed", node: "node" } }),
          aOne: peer({ url: "http://a-1", identity: { oracle: "aaa", node: "node" } }),
          zTwo: peer({ url: "http://z-2", identity: { oracle: "zed", node: "node" } }),
          aTwo: peer({ url: "http://a-2", identity: { oracle: "aaa", node: "node" } }),
        },
      });

      expect(duplicates.map((dup) => dup.key)).toEqual(["aaa:node", "zed:node"]);
      expect(warnings).toHaveLength(4);
      expect(warnings[0]).toContain('duplicate <oracle>:<node> claim "aaa:node"');
      expect(warnings[2]).toContain('duplicate <oracle>:<node> claim "zed:node"');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("src/lib/peers impl extra branch coverage", () => {
  const storePath = import.meta.resolve("../../src/lib/peers/store.ts");
  const probePath = import.meta.resolve("../../src/lib/peers/probe.ts");
  const tofuPath = import.meta.resolve("../../src/lib/peers/tofu.ts");

  let impl: typeof import("../../src/lib/peers/impl");
  let peers: Record<string, PeerShape> = {};
  let probeResult: ProbeShape = { node: "remote-node" };
  let probeCalls: string[] = [];
  let appliedKinds: string[] = [];

  beforeAll(async () => {
    mock.module(storePath, () => ({
      loadPeers: () => ({ version: 1, peers }),
      mutatePeers: (mutate: (data: { version: 1; peers: Record<string, PeerShape> }) => void) => {
        const data = { version: 1 as const, peers: { ...peers } };
        mutate(data);
        peers = data.peers;
        return data;
      },
    }));

    mock.module(probePath, () => ({
      probePeer: async (url: string) => {
        probeCalls.push(url);
        return probeResult;
      },
    }));

    mock.module(tofuPath, () => ({
      evaluatePeerIdentity: (alias: string, existing: PeerShape | undefined, observed: string | undefined) => ({
        kind: observed && !existing?.pubkey ? "tofu-bootstrap" : "match",
        alias,
        cached: existing?.pubkey,
        observed,
        message: "test decision",
      }),
      applyTofuDecision: (decision: { kind: string }) => {
        appliedKinds.push(decision.kind);
      },
      forgetPeerPubkey: () => "not-found",
      PeerPubkeyMismatchError: class extends Error {
        constructor(alias: string, cached: string, observed: string) {
          super(`peer pubkey changed for ${alias}: ${cached} → ${observed}`);
        }
      },
    }));

    impl = await import("../../src/lib/peers/impl");
  });

  beforeEach(() => {
    peers = {};
    probeResult = { node: "remote-node" };
    probeCalls = [];
    appliedKinds = [];
  });

  test("validation helpers and resolveNode cover invalid and fallback branches", async () => {
    expect(impl.validateAlias("m5-alpha_1")).toBeNull();
    expect(impl.validateAlias("BadAlias")).toContain("invalid alias");
    expect(impl.validateAlias("a".repeat(33))).toContain("invalid alias");
    expect(impl.validateUrl("not a url")).toBe('invalid URL "not a url"');
    expect(impl.validateUrl("file:///tmp/peer")).toContain("must be http:// or https://");
    expect(impl.validateUrl("https://peer.example")).toBeNull();

    probeResult = { node: null };
    expect(await impl.resolveNode("http://no-node")).toBeNull();
    expect(probeCalls).toEqual(["http://no-node"]);
  });

  test("cmdAdd prefers probed identity, records nickname, and cmdList/cmdInfo/formatList expose the stored peer", async () => {
    probeResult = {
      node: "probe-node",
      nickname: "Peer Nick",
      pubkey: "observed-key",
      identity: { oracle: "probe-oracle", node: "probe-node" },
    };

    const added = await impl.cmdAdd({
      alias: "zulu",
      url: "http://zulu.local:3456",
      identity: { oracle: "fallback-oracle", node: "fallback-node" },
    });

    expect(added).toMatchObject({ alias: "zulu", overwrote: false });
    expect(added.peer).toMatchObject({
      node: "probe-node",
      nickname: "Peer Nick",
      pubkey: "observed-key",
      identity: { oracle: "probe-oracle", node: "probe-node" },
    });
    expect(added.peer.lastSeen).toBeString();
    expect(appliedKinds).toEqual(["tofu-bootstrap"]);
    expect(impl.cmdInfo("missing")).toBeNull();
    expect(impl.cmdInfo("zulu")).toMatchObject({ alias: "zulu", node: "probe-node" });

    peers.alpha = peer({ url: "http://alpha", node: null, nickname: null, lastSeen: null });
    expect(impl.cmdList().map((row) => row.alias)).toEqual(["alpha", "zulu"]);
    const table = impl.formatList(impl.cmdList());
    expect(table).toContain("alias");
    expect(table).toContain("http://zulu.local:3456");
    expect(impl.formatList([])).toBe("no peers");
  });

  test("cmdAdd derives oneWay from probe failure and cmdRemove reports both miss and hit", async () => {
    probeResult = {
      node: null,
      error: { code: "REFUSED", message: "closed", at: "2026-05-18T00:00:00.000Z" },
    };

    const added = await impl.cmdAdd({
      alias: "closed",
      url: "http://closed.local:3456",
      markSymmetricCheck: true,
    });

    expect(added.peer).toMatchObject({
      node: null,
      lastSeen: null,
      oneWay: true,
      lastError: { code: "REFUSED", message: "closed" },
    });
    expect(impl.cmdRemove("missing")).toBe(false);
    expect(impl.cmdRemove("closed")).toBe(true);
    expect(peers.closed).toBeUndefined();
  });

  test("cmdProbe refreshes an existing peer and cmdForget delegates after validation", async () => {
    peers.probed = peer({
      url: "http://probed.local:3456",
      node: "old-node",
      nickname: "Old Nick",
      identity: { oracle: "old-oracle", node: "old-node" },
    });
    probeResult = {
      node: "fresh-node",
      nickname: null,
      identity: { oracle: "fresh-oracle", node: "fresh-node" },
    };

    const result = await impl.cmdProbe("probed");

    expect(result).toMatchObject({
      alias: "probed",
      url: "http://probed.local:3456",
      node: "fresh-node",
      ok: true,
    });
    expect(peers.probed).toMatchObject({
      node: "fresh-node",
      identity: { oracle: "fresh-oracle", node: "fresh-node" },
    });
    expect(peers.probed.nickname).toBeUndefined();
    expect(peers.probed.lastError).toBeUndefined();
    expect(appliedKinds).toEqual(["match"]);

    await expect(impl.cmdForget("BadAlias")).rejects.toThrow("invalid alias");
    expect(await impl.cmdForget("probed")).toBe("not-found");
  });
});

describe("vendor peer discovery client and formatter extra coverage", () => {
  const originalFetch = globalThis.fetch;
  let configPort = 4567;
  let discovery: typeof import("../../src/vendor/mpr-plugins/peers/discovered");
  let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  beforeAll(async () => {
    mock.module("maw-js/config", () => ({
      loadConfig: () => ({ port: configPort }),
    }));
    discovery = await import("../../src/vendor/mpr-plugins/peers/discovered");
  });

  beforeEach(() => {
    configPort = 4567;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetchDiscoveries sends query params, parses success, and surfaces non-404 daemon errors", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ ok: true, total: 2, shown: 1, filtered: false, peers: [] });
    }) as typeof fetch;

    const ok = await discovery.fetchDiscoveries({ all: true, limit: 1 });
    expect(ok).toMatchObject({ ok: true, total: 2, shown: 1 });
    expect(fetchCalls[0]?.url).toBe("http://localhost:4567/api/peers/discoveries?all=1&limit=1");

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "scout_unavailable", hint: "bind failed" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(discovery.fetchDiscoveries()).resolves.toMatchObject({
      ok: false,
      error: "scout_unavailable",
      hint: "bind failed",
      status: 503,
    });
  });

  test("fetchDiscoveries handles daemon unreachable, missing endpoint, and malformed error bodies", async () => {
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    await expect(discovery.fetchDiscoveries()).resolves.toMatchObject({
      ok: false,
      error: "daemon_unreachable",
      hint: expect.stringContaining("maw serve"),
    });

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(discovery.fetchDiscoveries()).resolves.toMatchObject({
      ok: false,
      error: "discovery_endpoint_missing",
      status: 404,
      hint: expect.stringContaining("restart `maw serve`"),
    });

    globalThis.fetch = (async () => new Response("not json", { status: 500 })) as typeof fetch;
    await expect(discovery.fetchDiscoveries()).resolves.toMatchObject({
      ok: false,
      error: "http_500",
      status: 500,
    });
  });

  test("acceptPeer posts JSON, parses success, includes candidates on errors, and handles unreachable daemon", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ ok: true, alias: "m5", node: "m5", url: "http://m5" });
    }) as typeof fetch;

    await expect(discovery.acceptPeer({ id: "zid-1", alias: "m5" })).resolves.toMatchObject({ ok: true, alias: "m5" });
    expect(fetchCalls[0]?.url).toBe("http://localhost:4567/api/peers/accept");
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ id: "zid-1", alias: "m5" });

    globalThis.fetch = (async () => Response.json({
      error: "ambiguous_discovery",
      hint: "choose one",
      candidates: [{ id: "one" }, { id: "two" }],
    }, { status: 409 })) as typeof fetch;
    const rejected = await discovery.acceptPeer({ alias: "m5" }) as any;
    expect(rejected).toMatchObject({ ok: false, error: "ambiguous_discovery", status: 409 });
    expect(rejected.candidates).toHaveLength(2);

    globalThis.fetch = (async () => { throw "offline"; }) as typeof fetch;
    await expect(discovery.acceptPeer({ all: true })).resolves.toMatchObject({
      ok: false,
      error: "daemon_unreachable",
      hint: expect.stringContaining("offline"),
    });
  });

  test("formatDiscoveries covers empty states, table defaults, truncation, and limit hint", () => {
    expect(discovery.formatDiscoveries({ ok: true, total: 0, shown: 0, filtered: false, peers: [] })).toBe("no discoveries");
    expect(discovery.formatDiscoveries({ ok: true, total: 0, shown: 0, filtered: true, peers: [] })).toContain("pass --all");

    const rendered = discovery.formatDiscoveries({
      ok: true,
      total: 3,
      shown: 1,
      filtered: false,
      peers: [{
        zid: "abcdef1234567890",
        node: "m5",
        oracle: "mawjs",
        host: "m5.local",
        locators: ["http://m5"],
        capabilities: [],
        oracles: [],
        firstSeen: "2026-05-18T00:00:00.000Z",
        lastSeen: "2026-05-18T00:01:00.000Z",
        seenRel: "1m",
        paired: true,
      }],
    });

    expect(rendered).toContain("abcdef12…");
    expect(rendered).toContain("✓");
    expect(rendered).toContain("-");
    expect(rendered).toContain("(1/3 shown — pass --limit N to widen)");
  });
});
