/**
 * Tests for #1237 — /api/peers/discoveries + /api/peers/accept.
 *
 * Hermetic: stubs the scout singleton with an in-memory fake so we don't bind
 * a real UDP socket, and points PEERS_FILE at a tmp file so cmdAdd writes
 * land in an isolated store. The probe path is mocked to short-circuit the
 * /info handshake.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── Stub probe so cmdAdd does not hit the network ──────────────────────
mock.module("../src/lib/peers/probe", () => ({
  probePeer: async (url: string) => {
    // Encode "pubkey collision" scenarios in the URL so individual tests
    // can drive the impersonation guard. Default behaviour: derive a stable
    // synthetic pubkey from the URL itself.
    const u = new URL(url);
    const pubkey = u.searchParams.get("pubkey") ?? `pk-${u.hostname}-${u.port || "0"}`;
    return {
      node: u.hostname,
      nickname: null,
      pubkey,
      identity: { oracle: "mawjs", node: u.hostname },
      // no error → success
    };
  },
  PROBE_EXIT_CODES: { DNS: 3, REFUSED: 4, TIMEOUT: 5, HTTP_4XX: 6, HTTP_5XX: 6, TLS: 2, BAD_BODY: 2, UNKNOWN: 2 },
}));

// ─── Fake ScoutTransport singleton ──────────────────────────────────────
function makeFakeScout(initial: Array<Partial<{
  zid: string; node: string; host: string; oracle: string;
  locators: string[]; capabilities: string[]; oracles: string[];
  firstSeen: number; lastSeen: number; paired: boolean;
}>>) {
  const peers = initial.map((p, i) => ({
    zid: p.zid ?? `zid-${i.toString().padStart(8, "0")}`,
    node: p.node ?? `node-${i}`,
    host: p.host ?? "192.168.1." + (10 + i),
    oracle: p.oracle ?? "mawjs",
    locators: p.locators ?? [`http://host-${i}:3456`],
    capabilities: p.capabilities ?? ["pair"],
    oracles: p.oracles ?? [],
    firstSeen: p.firstSeen ?? Date.now() - 10000,
    lastSeen: p.lastSeen ?? Date.now(),
    paired: p.paired ?? false,
  }));
  return {
    discoveriesSnapshot() {
      return [...peers].sort((a, b) => b.lastSeen - a.lastSeen);
    },
    _peers: peers,
  };
}

let scoutSingleton: any = null;
mock.module("../src/transports/scout", () => ({
  getCurrentScout: () => scoutSingleton,
  _setCurrentScout: (s: any) => { scoutSingleton = s; },
}));

mock.module("../src/config", () => ({
  loadConfig: () => ({ node: "test-node", port: 3456 }),
}));

const { pairApi } = await import("../src/api/pair");
const app = new Elysia({ prefix: "/api" }).use(pairApi);

async function get(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}
async function post(path: string, body: any) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-peers-discov-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
  scoutSingleton = null;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

describe("GET /api/peers/discoveries (#1237)", () => {
  test("503 when scout transport is unbound (open question #1: hard error)", async () => {
    const res = await get("/api/peers/discoveries");
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("scout_unavailable");
  });

  test("returns sorted snapshot (lastSeen desc) with relative seen string", async () => {
    scoutSingleton = makeFakeScout([
      { zid: "aa".repeat(16), node: "old", lastSeen: Date.now() - 60_000 },
      { zid: "bb".repeat(16), node: "fresh", lastSeen: Date.now() - 1000 },
    ]);
    const res = await get("/api/peers/discoveries");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.peers).toHaveLength(2);
    expect(body.peers[0].node).toBe("fresh");
    expect(body.peers[1].node).toBe("old");
    expect(body.peers[0].seenRel).toBeTruthy();
  });

  test("hides paired by default; --all (?all=1) includes them", async () => {
    scoutSingleton = makeFakeScout([
      { zid: "11".repeat(16), node: "a", paired: false },
      { zid: "22".repeat(16), node: "b", paired: true },
    ]);
    const def: any = await (await get("/api/peers/discoveries")).json();
    expect(def.peers).toHaveLength(1);
    expect(def.peers[0].node).toBe("a");
    expect(def.filtered).toBe(true);

    const all: any = await (await get("/api/peers/discoveries?all=1")).json();
    expect(all.peers).toHaveLength(2);
    expect(all.filtered).toBe(false);
  });

  test("--limit caps result count", async () => {
    scoutSingleton = makeFakeScout(
      Array.from({ length: 60 }, (_, i) => ({ zid: i.toString(16).padStart(32, "0"), node: `n${i}` })),
    );
    const r: any = await (await get("/api/peers/discoveries?limit=5")).json();
    expect(r.peers).toHaveLength(5);
    expect(r.total).toBe(60);
  });
});

describe("POST /api/peers/accept (#1237)", () => {
  test("400 when neither id nor all is provided", async () => {
    scoutSingleton = makeFakeScout([{ zid: "aa".repeat(16), node: "a" }]);
    const res = await post("/api/peers/accept", {});
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe("missing_id");
  });

  test("503 when scout is unbound", async () => {
    const res = await post("/api/peers/accept", { id: "anything" });
    expect(res.status).toBe(503);
  });

  test("404 when no candidate matches the id", async () => {
    scoutSingleton = makeFakeScout([{ zid: "aa".repeat(16), node: "a" }]);
    const res = await post("/api/peers/accept", { id: "ghost" });
    expect(res.status).toBe(404);
  });

  test("accepts by node name → writes peers.json entry", async () => {
    scoutSingleton = makeFakeScout([{
      zid: "ab".repeat(16),
      node: "mba",
      locators: ["http://10.0.0.5:3456"],
    }]);
    const res = await post("/api/peers/accept", { id: "mba" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alias).toBe("mba");

    const { loadPeers } = await import("../src/lib/peers/store");
    expect(loadPeers().peers.mba?.url).toBe("http://10.0.0.5:3456");
  });

  test("accepts by zid prefix when unambiguous", async () => {
    scoutSingleton = makeFakeScout([
      { zid: "ab" + "0".repeat(30), node: "alpha", locators: ["http://10.0.0.6:3456"] },
      { zid: "cd" + "0".repeat(30), node: "bravo", locators: ["http://10.0.0.7:3456"] },
    ]);
    const res = await post("/api/peers/accept", { id: "ab" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.alias).toBe("alpha");
  });

  test("409 when zid prefix is ambiguous → returns candidate list", async () => {
    scoutSingleton = makeFakeScout([
      { zid: "ab" + "1".repeat(30), node: "a1" },
      { zid: "ab" + "2".repeat(30), node: "a2" },
    ]);
    const res = await post("/api/peers/accept", { id: "ab" });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error).toBe("ambiguous");
    expect(body.candidates).toHaveLength(2);
  });

  test("--alias override is honored", async () => {
    scoutSingleton = makeFakeScout([{
      zid: "ee".repeat(16),
      node: "white",
      locators: ["http://10.0.0.8:3456"],
    }]);
    const res = await post("/api/peers/accept", { id: "white", alias: "snow" });
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alias).toBe("snow");

    const { loadPeers } = await import("../src/lib/peers/store");
    expect(loadPeers().peers.snow).toBeDefined();
    expect(loadPeers().peers.white).toBeUndefined();
  });

  test("impersonation guard (decision #4) — refuses when pubkey already pins under a different alias", async () => {
    // Seed: alias "ghost" already pins pubkey pk-evil-3456.
    const { savePeers } = await import("../src/lib/peers/store");
    savePeers({
      version: 1,
      peers: {
        ghost: {
          url: "http://evil:3456",
          node: "evil",
          addedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          pubkey: "pk-evil-3456",
          pubkeyFirstSeen: new Date().toISOString(),
        },
      },
    });

    // Discovery announces a NEW peer that probes to the SAME pubkey.
    scoutSingleton = makeFakeScout([{
      zid: "ff".repeat(16),
      node: "evil",
      locators: ["http://evil:3456"], // probePeer stub keys off hostname:port → pk-evil-3456
    }]);

    const res = await post("/api/peers/accept", { id: "evil", alias: "twin" });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error).toBe("impersonation_guard");
    expect(body.hint).toContain("ghost");

    // Guard must be a true refusal — no `twin` left behind on disk.
    const { loadPeers } = await import("../src/lib/peers/store");
    expect(loadPeers().peers.twin).toBeUndefined();
  });

  test("--all accepts every unpaired candidate in parallel", async () => {
    scoutSingleton = makeFakeScout([
      { zid: "11".repeat(16), node: "n1", locators: ["http://1.2.3.1:3456"], paired: false },
      { zid: "22".repeat(16), node: "n2", locators: ["http://1.2.3.2:3456"], paired: false },
      { zid: "33".repeat(16), node: "n3", locators: ["http://1.2.3.3:3456"], paired: true }, // skipped
    ]);
    const res = await post("/api/peers/accept", { all: true });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.accepted).toHaveLength(2);
    expect(body.accepted.map((r: any) => r.alias).sort()).toEqual(["n1", "n2"]);

    const { loadPeers } = await import("../src/lib/peers/store");
    expect(Object.keys(loadPeers().peers).sort()).toEqual(["n1", "n2"]);
  });
});
