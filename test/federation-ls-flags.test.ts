/**
 * `maw federation ls -a / -v` (#1329) — tests for opts-aware rendering.
 *
 * The implementation extends `cmdFederationStatus` with `{ all, verbose }`
 * opts. Both flags default to false so the bare `maw federation ls` output
 * is byte-for-byte unchanged — the backward-compat case below is the
 * load-bearing test for this PR.
 *
 * Mocks `../src/sdk`, `../src/config`, `../src/lib/peers/store` so this
 * file is fully hermetic: no HTTP, no ~/.maw reads, no real tmux. Per-test
 * state is mutated via the `setMockState` helper before each call.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Hermetic state (mutated per-test) ────────────────────────────────────
type PeerStatusMock = {
  url: string;
  reachable: boolean;
  latency: number;
  node?: string;
};

interface MockState {
  peers: string[];                          // from getPeers()
  statuses: PeerStatusMock[];               // from getFederationStatus().peers
  localUrl: string;                         // from getFederationStatus().localUrl
  localAgents: number;                      // from listSessions()
  agentsPerPeer: (url: string) => number;   // from curlFetch /api/sessions
  config: { node: string; port: number; namedPeers: Array<{ name: string; url: string }> };
  peerStore: Record<string, any>;           // from loadPeers().peers
}

const state: MockState = {
  peers: [],
  statuses: [],
  localUrl: "http://localhost:3456",
  localAgents: 0,
  agentsPerPeer: () => 0,
  config: { node: "m5", port: 3456, namedPeers: [] },
  peerStore: {},
};

function setMockState(patch: Partial<MockState>) {
  Object.assign(state, patch);
}

function resetMockState() {
  state.peers = [];
  state.statuses = [];
  state.localUrl = "http://localhost:3456";
  state.localAgents = 0;
  state.agentsPerPeer = () => 0;
  state.config = { node: "m5", port: 3456, namedPeers: [] };
  state.peerStore = {};
}

// ─── Module mocks ─────────────────────────────────────────────────────────
mock.module("../src/sdk", () => ({
  getPeers: () => state.peers,
  getFederationStatus: async () => ({
    peers: state.statuses,
    localUrl: state.localUrl,
    totalPeers: state.statuses.length,
    reachablePeers: state.statuses.filter(s => s.reachable).length,
    clockHealth: { clockUtc: "", timezone: "", uptimeSeconds: 0 },
  }),
  curlFetch: async (url: string) => {
    // fetchPeerAgentCount() pulls `${url}/api/sessions` then sums windows
    const base = url.replace(/\/api\/sessions$/, "");
    const n = state.agentsPerPeer(base);
    return { ok: true, status: 200, data: [{ windows: Array.from({ length: n }, () => ({})) }] };
  },
  listSessions: async () => {
    return [{ windows: Array.from({ length: state.localAgents }, () => ({})) }];
  },
}));

mock.module("../src/config", () => ({
  loadConfig: () => state.config,
}));

mock.module("../src/lib/peers/store", () => ({
  loadPeers: () => ({ version: 1, peers: state.peerStore }),
}));

// Dynamic import AFTER mocks are installed so the SUT picks them up.
const { cmdFederationStatus } = await import("../src/commands/shared/federation");

// ─── console.log capture ──────────────────────────────────────────────────
async function capture(opts: { all?: boolean; verbose?: boolean } = {}): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    await cmdFederationStatus(opts);
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

// ─── Shared fixtures ──────────────────────────────────────────────────────
function twoPeersFixture() {
  // Two peers: alpha (reachable, live-tagged node "alpha-node", in TOFU cache);
  // beta (unreachable, no live node, NOT in cache).
  setMockState({
    peers: ["http://a.example:3456", "http://b.example:3456"],
    statuses: [
      { url: "http://a.example:3456", reachable: true, latency: 10, node: "alpha-node" },
      { url: "http://b.example:3456", reachable: false, latency: 0 },
    ],
    localAgents: 2,
    agentsPerPeer: (url) => (url === "http://a.example:3456" ? 2 : 0),
    config: {
      node: "m5",
      port: 3456,
      namedPeers: [
        { name: "alpha", url: "http://a.example:3456" },
        { name: "beta", url: "http://b.example:3456" },
      ],
    },
    peerStore: {
      "http://a.example:3456": {
        url: "http://a.example:3456",
        node: "alpha-node",
        addedAt: "2026-05-01T00:00:00Z",
        lastSeen: "2026-05-13T10:00:00.123Z",
        pubkey: "abcdef0123456789aaaaaaaaaaaaaaaa",
        identity: { oracle: "soul", node: "alpha-node" },
      },
    },
  });
}

beforeEach(() => resetMockState());

// ─── Backward-compat (the load-bearing case) ──────────────────────────────
describe("federation ls — backward compat (no flags)", () => {
  it("default output is byte-for-byte unchanged from pre-#1329", async () => {
    twoPeersFixture();
    const out = await capture(); // no opts → all=false, verbose=false

    // Build the exact expected string, line-by-line, from the pre-#1329 contract.
    const expected = [
      "",
      "\x1b[36;1mFederation Status\x1b[0m  \x1b[90m3 nodes (1 local + 2 peers)\x1b[0m",
      "",
      "  \x1b[32m●\x1b[0m  \x1b[37mm5 (local)\x1b[0m  \x1b[32monline\x1b[0m  \x1b[90m2 agents\x1b[0m",
      "     \x1b[90mhttp://localhost:3456\x1b[0m",
      "  \x1b[32m●\x1b[0m  \x1b[37malpha\x1b[0m  \x1b[32mreachable\x1b[0m  \x1b[90m10ms · 2 agents\x1b[0m",
      "     \x1b[90mhttp://a.example:3456\x1b[0m",
      "  \x1b[31m●\x1b[0m  \x1b[37mbeta\x1b[0m  \x1b[31munreachable\x1b[0m",
      "     \x1b[90mhttp://b.example:3456\x1b[0m",
      "",
      "\x1b[90m2/3 reachable (one-way; use --verify for pair-symmetric check — PR #398)\x1b[0m",
      "",
    ].join("\n");

    expect(out).toBe(expected);

    // Defensive: even when only one flag is unset, neither block leaks in.
    expect(out).not.toMatch(/node:/);
    expect(out).not.toMatch(/pubkey:/);
    expect(out).not.toMatch(/lastSeen:/);
    expect(out).not.toMatch(/version:/);
  });

  it("default with no peers configured shows the helpful hint, not -a/-v rows", async () => {
    setMockState({
      peers: [],
      statuses: [],
      localAgents: 1,
      config: { node: "m5", port: 3456, namedPeers: [] },
    });
    const out = await capture();
    expect(out).toContain("Federation Status");
    expect(out).toContain("m5 (local)");
    expect(out).toContain("No peers configured");
    expect(out).toContain("namedPeers");
    expect(out).not.toMatch(/node:/);
    expect(out).not.toMatch(/pubkey:/);
  });
});

// ─── -a / --all ───────────────────────────────────────────────────────────
describe("federation ls -a — surfaces node identity per peer", () => {
  it("appends `node: <name>` line for each peer (live-probe wins)", async () => {
    twoPeersFixture();
    const out = await capture({ all: true });

    expect(out).toContain("node: alpha-node");          // from live probe
    expect(out).toContain("node: (unknown)");           // beta: no live, no cache
    // Backward-compat invariant: -a alone never enables -v fields.
    expect(out).not.toMatch(/pubkey:/);
    expect(out).not.toMatch(/version:/);
  });

  it("local row never gets a `node:` line — its label already names it", async () => {
    twoPeersFixture();
    const out = await capture({ all: true });

    // Split on the local-url line; everything before it is the local block,
    // which must not contain a `node:` annotation.
    const idx = out.indexOf("http://localhost:3456");
    const localBlock = out.slice(0, idx + "http://localhost:3456".length);
    expect(localBlock).not.toMatch(/node:/);
  });

  it("when -a is set ALONE, unknown-live peer renders `node: (unknown)` even if cache has it", async () => {
    // OBSERVED IMPL QUIRK (#1329): peerStore is only loaded when `verbose=true`,
    // so the `findCachedPeer(...)` fallback inside the `-a` block sees an empty
    // store when `-v` is not also set. End-user impact: `-a` alone never
    // surfaces a cached node name — it only shows live-probe results.
    // Cache fallback DOES work under `-av` (see -av suite below).
    setMockState({
      peers: ["http://c.example:3456"],
      statuses: [
        { url: "http://c.example:3456", reachable: false, latency: 0 },
      ],
      localAgents: 0,
      config: { node: "m5", port: 3456, namedPeers: [{ name: "cached", url: "http://c.example:3456" }] },
      peerStore: {
        "http://c.example:3456": {
          url: "http://c.example:3456",
          node: "cached-node-from-tofu",
          addedAt: "2026-05-01T00:00:00Z",
          lastSeen: null,
        },
      },
    });
    const out = await capture({ all: true });
    expect(out).toContain("node: (unknown)");
  });
});

// ─── -v / --verbose ───────────────────────────────────────────────────────
describe("federation ls -v — surfaces cached TOFU fields per peer", () => {
  it("renders pubkey (8-char) / lastSeen / version / oracle for cached peer", async () => {
    twoPeersFixture();
    const out = await capture({ verbose: true });

    // alpha: cached → real pubkey prefix, formatted lastSeen, oracle from identity
    expect(out).toContain("pubkey: abcdef01");                      // 8-char slice
    expect(out).toContain("lastSeen: 2026-05-13T10:00:00Z");         // sub-second trimmed
    expect(out).toContain("version: unknown");                       // deferred to follow-up
    expect(out).toContain("oracle: soul");

    // -v alone never enables -a.
    expect(out).not.toMatch(/^.*node: alpha-node/m);
  });

  it("uncached peer renders all placeholders without crashing", async () => {
    twoPeersFixture();
    const out = await capture({ verbose: true });

    // beta has no cache → "-" / "never" / "unknown" / "-"
    // Find beta's verbose line by anchoring on the beta URL line.
    const lines = out.split("\n");
    const betaUrlIdx = lines.findIndex(l => l.includes("http://b.example:3456"));
    expect(betaUrlIdx).toBeGreaterThanOrEqual(0);
    // verbose line follows the url line for that peer
    const verboseLine = lines[betaUrlIdx + 1] ?? "";
    expect(verboseLine).toContain("pubkey: -");
    expect(verboseLine).toContain("lastSeen: never");
    expect(verboseLine).toContain("version: unknown");
    expect(verboseLine).toContain("oracle: -");
  });

  it("version is always 'unknown' (deferred to follow-up, never crashes)", async () => {
    twoPeersFixture();
    const out = await capture({ verbose: true });
    // Every verbose row carries version: unknown (alpha + beta = 2 occurrences)
    const versionMatches = out.match(/version: unknown/g) ?? [];
    expect(versionMatches.length).toBe(2);
  });

  it("local row never gets a `pubkey:` line — its label already names it", async () => {
    twoPeersFixture();
    const out = await capture({ verbose: true });
    const idx = out.indexOf("http://localhost:3456");
    const localBlock = out.slice(0, idx + "http://localhost:3456".length);
    expect(localBlock).not.toMatch(/pubkey:/);
    expect(localBlock).not.toMatch(/lastSeen:/);
  });
});

// ─── -av (bundle: both flags) ─────────────────────────────────────────────
describe("federation ls -av — both behaviors combined", () => {
  it("renders both `node:` and `pubkey:` lines per peer row", async () => {
    twoPeersFixture();
    const out = await capture({ all: true, verbose: true });

    // alpha: both blocks present
    expect(out).toContain("node: alpha-node");
    expect(out).toContain("pubkey: abcdef01");
    expect(out).toContain("oracle: soul");

    // beta: both blocks present with placeholders
    expect(out).toContain("node: (unknown)");
    expect(out).toContain("pubkey: -");
    expect(out).toContain("lastSeen: never");
  });

  it("each peer row gets node-line then pubkey-line (ordering preserved)", async () => {
    twoPeersFixture();
    const out = await capture({ all: true, verbose: true });
    const lines = out.split("\n");
    const alphaUrlIdx = lines.findIndex(l => l.includes("http://a.example:3456"));
    expect(alphaUrlIdx).toBeGreaterThanOrEqual(0);
    // After alpha URL: node line, then pubkey line.
    expect(lines[alphaUrlIdx + 1]).toContain("node: alpha-node");
    expect(lines[alphaUrlIdx + 2]).toContain("pubkey: abcdef01");
  });

  it("local row gets neither -a nor -v line under -av", async () => {
    twoPeersFixture();
    const out = await capture({ all: true, verbose: true });
    const idx = out.indexOf("http://localhost:3456");
    const localBlock = out.slice(0, idx + "http://localhost:3456".length);
    expect(localBlock).not.toMatch(/node:/);
    expect(localBlock).not.toMatch(/pubkey:/);
  });

  it("under -av, `node:` falls back to cached node when live probe is missing", async () => {
    // Mirror of the `-a`-alone quirk above: with `-v` ALSO set, peerStore is
    // loaded, so the cache fallback inside the `-a` block actually fires.
    setMockState({
      peers: ["http://c.example:3456"],
      statuses: [
        { url: "http://c.example:3456", reachable: false, latency: 0 },
      ],
      localAgents: 0,
      config: { node: "m5", port: 3456, namedPeers: [{ name: "cached", url: "http://c.example:3456" }] },
      peerStore: {
        "http://c.example:3456": {
          url: "http://c.example:3456",
          node: "cached-node-from-tofu",
          addedAt: "2026-05-01T00:00:00Z",
          lastSeen: null,
        },
      },
    });
    const out = await capture({ all: true, verbose: true });
    expect(out).toContain("node: cached-node-from-tofu");
  });

  it("with zero peers, -av is a no-op (no rows to annotate)", async () => {
    setMockState({
      peers: [],
      statuses: [],
      localAgents: 0,
      config: { node: "m5", port: 3456, namedPeers: [] },
    });
    const out = await capture({ all: true, verbose: true });
    expect(out).toContain("No peers configured");
    expect(out).not.toMatch(/node:/);
    expect(out).not.toMatch(/pubkey:/);
  });
});
