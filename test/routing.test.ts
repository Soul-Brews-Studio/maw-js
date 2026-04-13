/**
 * Tests for resolveTarget() — the shared routing resolver.
 * Test cases designed by oracle-world:mawjs, implemented by white:mawjs-oracle.
 * See: #201
 */
import { describe, test, expect } from "bun:test";
import { resolveTarget } from "../src/core/routing";
import type { Session } from "../src/core/runtime/find-window";
import type { MawConfig } from "../src/config";

// --- Fixtures ---

const SESSIONS: Session[] = [
  { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
  { name: "13-mother", windows: [{ index: 1, name: "mother-oracle", active: true }] },
  { name: "01-pulse", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
];

const BASE_CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/home/nat/Code/github.com",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "white",
  namedPeers: [
    { name: "mba", url: "http://10.20.0.3:3457" },
    { name: "oracle-world", url: "http://100.120.242.120:3456" },
  ],
  agents: {
    homekeeper: "mba",
    neo: "white",
    boonkeeper: "oracle-world",
    volt: "mba",
  },
  peers: ["http://10.20.0.3:3457"],
};

// --- Test cases (designed by oracle-world:mawjs) ---

describe("resolveTarget", () => {
  // #1: LOCAL SESSION FOUND (bare name)
  test("bare name matches local session window", () => {
    const r = resolveTarget("mother-oracle", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "local", target: "13-mother:1" });
  });

  // #2: LOCAL SESSION FOUND (session:window format)
  test("session:window format matches locally", () => {
    const r = resolveTarget("13-mother:mother-oracle", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "local", target: "13-mother:1" });
  });

  // #3: NODE:AGENT → REMOTE PEER
  test("node:agent resolves to remote peer", () => {
    const r = resolveTarget("mba:homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://10.20.0.3:3457", target: "homekeeper", node: "mba" });
  });

  // #4: NODE:AGENT → SELF-NODE (local match exists)
  test("self-node prefix resolves locally", () => {
    const r = resolveTarget("white:mawjs", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "self-node", target: "08-mawjs:1" });
  });

  // #5: NODE:AGENT → SELF-NODE (no local match)
  test("self-node prefix with no local match returns error", () => {
    const r = resolveTarget("white:ghost", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "self_not_running" });
  });

  // #6: NODE:AGENT → UNKNOWN NODE
  test("unknown node returns error", () => {
    const r = resolveTarget("mars:neo", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "unknown_node" });
  });

  // #7: BARE NAME → AGENTS MAP → REMOTE
  test("bare name in agents map resolves to peer", () => {
    const r = resolveTarget("homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://10.20.0.3:3457", target: "homekeeper", node: "mba" });
  });

  // #8: BARE NAME → AGENTS MAP → SELF (skip, treat as local miss)
  test("bare name mapped to self-node returns error", () => {
    const r = resolveTarget("neo", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "self_not_running" });
  });

  // #10: BARE NAME → NOT FOUND
  test("bare name not found anywhere returns error", () => {
    const r = resolveTarget("ghost", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });

  // #11: BARE NAME WITH -oracle SUFFIX STRIP
  test("agents map matches after stripping -oracle suffix", () => {
    const r = resolveTarget("homekeeper-oracle", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://10.20.0.3:3457", target: "homekeeper-oracle", node: "mba" });
  });

  // #12: SLASH IN QUERY (not node:agent)
  test("query with slash is not treated as node:agent", () => {
    const r = resolveTarget("13-mother/worktree", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });

  // #13: PEER URL FALLBACK (peers[] array — URL must contain node name)
  test("node:agent falls back to peers[] when namedPeers misses", () => {
    const config = { ...BASE_CONFIG, namedPeers: [], peers: ["http://mba.wg:3457"] };
    const r = resolveTarget("mba:homekeeper", config, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://mba.wg:3457", target: "homekeeper", node: "mba" });
  });

  // #14: AGENTS MAP → NODE EXISTS BUT NO PEER URL
  test("agent mapped to node with no peer URL returns error", () => {
    const config = { ...BASE_CONFIG, namedPeers: [], peers: [] };
    const r = resolveTarget("homekeeper", config, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "no_peer_url" });
  });

  // #15: EMPTY QUERY
  test("empty query returns error", () => {
    const r = resolveTarget("", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "empty_query" });
  });

  // #16: COLON WITH EMPTY NODE
  test("empty node prefix returns error", () => {
    const r = resolveTarget(":agent", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
  });

  // #17: COLON WITH EMPTY AGENT
  test("empty agent after colon returns error", () => {
    const r = resolveTarget("node:", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
  });

  // #18: MULTIPLE COLONS
  test("multiple colons split on first only", () => {
    const r = resolveTarget("mba:home:keeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://10.20.0.3:3457", target: "home:keeper", node: "mba" });
  });

  // BONUS: oracle-world:agent resolves correctly
  test("oracle-world:boonkeeper resolves to peer", () => {
    const r = resolveTarget("oracle-world:boonkeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://100.120.242.120:3456", target: "boonkeeper", node: "oracle-world" });
  });

  // BONUS: boonkeeper via agents map
  test("boonkeeper bare name resolves via agents map", () => {
    const r = resolveTarget("boonkeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "peer", peerUrl: "http://100.120.242.120:3456", target: "boonkeeper", node: "oracle-world" });
  });
});
