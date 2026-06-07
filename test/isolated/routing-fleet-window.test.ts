/**
 * routing-fleet-window.test.ts — #1565 regression.
 *
 * Fleet-known oracle aliases must not silently route to windows[0] in a
 * multi-window tmux session. After a session reshuffle, windows[0] can be the
 * sender/helper pane; `maw hey m5:mawjs` should prefer `mawjs-oracle` or fail
 * loudly with candidates instead of looping back to the sender.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import type { MawConfig } from "../../src/config";
import type { Session } from "../../src/core/runtime/find-window";

let fleetSessions: Record<string, string | null> = {};
let manifestEntries: Array<{ name: string; node?: string }> = [];

mock.module(join(import.meta.dir, "../../src/commands/shared/wake"), () => ({
  resolveFleetSession: (oracle: string) => fleetSessions[oracle] ?? null,
}));

mock.module(join(import.meta.dir, "../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => manifestEntries,
}));

const { resolveTarget } = await import("../../src/core/routing");

const CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/home/nat/Code/github.com",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "m5",
  namedPeers: [],
  agents: {},
  peers: [],
};

const MULTI_WINDOW_MAWJS: Session[] = [
  {
    name: "54-mawjs",
    windows: [
      { index: 1, name: "mawjs-issuer", active: true },
      { index: 2, name: "mawjs-oracle", active: false },
      { index: 3, name: "mawjs-smoke", active: false },
      { index: 4, name: "mawjs-codex-headless", active: false },
    ],
  },
];

describe("resolveTarget — fleet window routing (#1565)", () => {
  beforeEach(() => {
    fleetSessions = { mawjs: "54-mawjs" };
    manifestEntries = [];
  });

  test("self-node fleet alias prefers <query>-oracle over windows[0]", () => {
    const r = resolveTarget("m5:mawjs", CONFIG, MULTI_WINDOW_MAWJS);
    expect(r).toEqual({ type: "self-node", target: "54-mawjs:2" });
  });

  test("bare fleet alias prefers <query>-oracle before generic session-first routing", () => {
    const r = resolveTarget("mawjs", CONFIG, MULTI_WINDOW_MAWJS);
    expect(r).toEqual({ type: "local", target: "54-mawjs:2" });
  });

  test("self-node session alias still prefers <query>-oracle when fleet config misses", () => {
    fleetSessions = {};
    const r = resolveTarget("m5:mawjs", CONFIG, MULTI_WINDOW_MAWJS);
    expect(r).toEqual({ type: "self-node", target: "54-mawjs:2" });
  });

  test("bare session alias still prefers <query>-oracle when fleet config misses", () => {
    fleetSessions = {};
    const r = resolveTarget("mawjs", CONFIG, MULTI_WINDOW_MAWJS);
    expect(r).toEqual({ type: "local", target: "54-mawjs:2" });
  });

  test("multi-window fleet alias without oracle window fails loud with candidates", () => {
    const sessions: Session[] = [
      {
        name: "54-mawjs",
        windows: [
          { index: 1, name: "mawjs-issuer", active: true },
          { index: 3, name: "mawjs-smoke", active: false },
        ],
      },
    ];

    const r = resolveTarget("m5:mawjs", CONFIG, sessions);

    expect(r).toMatchObject({
      type: "error",
      reason: "fleet_window_not_found",
    });
    expect(r && "detail" in r ? r.detail : "").toContain("refusing to default to the first window");
    expect(r && "hint" in r ? r.hint : "").toContain("54-mawjs:1 (mawjs-issuer)");
    expect(r && "hint" in r ? r.hint : "").toContain("54-mawjs:3 (mawjs-smoke)");
  });

  test("multi-window session alias without oracle window fails loud when fleet config misses", () => {
    fleetSessions = {};
    const sessions: Session[] = [
      {
        name: "54-mawjs",
        windows: [
          { index: 1, name: "mawjs-issuer", active: true },
          { index: 3, name: "mawjs-smoke", active: false },
        ],
      },
    ];

    const r = resolveTarget("m5:mawjs", CONFIG, sessions);

    expect(r).toMatchObject({
      type: "error",
      reason: "session_window_not_found",
    });
    expect(r && "detail" in r ? r.detail : "").toContain("refusing to default to the first window");
    expect(r && "hint" in r ? r.hint : "").toContain("54-mawjs:1 (mawjs-issuer)");
  });

  test("single-window fleet alias keeps unambiguous first-window fallback", () => {
    const r = resolveTarget("m5:mawjs", CONFIG, [
      { name: "54-mawjs", windows: [{ index: 7, name: "mawjs-issuer", active: true }] },
    ]);

    expect(r).toEqual({ type: "self-node", target: "54-mawjs:7" });
  });
});


describe("resolveTarget — routing edge coverage", () => {
  beforeEach(() => {
    fleetSessions = {};
    manifestEntries = [];
  });

  test("rejects empty queries and malformed node:agent syntax", () => {
    expect(resolveTarget("", CONFIG, [])).toMatchObject({ type: "error", reason: "empty_query" });
    expect(resolveTarget("m5:", CONFIG, [])).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
    expect(resolveTarget(":homekeeper", CONFIG, [])).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
  });

  test("filters read-only view and remote-source sessions before local matching", () => {
    const sessions: Array<Session & { source?: string }> = [
      { name: "homekeeper-view", windows: [{ index: 1, name: "homekeeper-oracle", active: true }] },
      { name: "remote-homekeeper", source: "peer", windows: [{ index: 2, name: "remote-oracle", active: true }] },
    ];

    expect(resolveTarget("homekeeper", CONFIG, sessions)).toMatchObject({ type: "error", reason: "not_found" });
  });

  test("routes explicit remote nodes and reports unknown node names", () => {
    const config: MawConfig = {
      ...CONFIG,
      namedPeers: [{ name: "white", url: "http://white:3456" }],
      peers: ["http://legacy-mba:3456"],
    };

    expect(resolveTarget("white:homekeeper", config, [])).toEqual({
      type: "peer",
      peerUrl: "http://white:3456",
      target: "homekeeper",
      node: "white",
    });
    expect(resolveTarget("legacy-mba:neo", config, [])).toEqual({
      type: "peer",
      peerUrl: "http://legacy-mba:3456",
      target: "neo",
      node: "legacy-mba",
    });
    expect(resolveTarget("missing:neo", config, [])).toMatchObject({ type: "error", reason: "unknown_node" });
  });

  test("manifest entries route to remote peers only when config has a peer URL", () => {
    manifestEntries = [{ name: "calliope", node: "white" }];
    const config: MawConfig = { ...CONFIG, namedPeers: [{ name: "white", url: "http://white:3456" }] };
    expect(resolveTarget("calliope", config, [])).toEqual({
      type: "peer",
      peerUrl: "http://white:3456",
      target: "calliope",
      node: "white",
    });

    manifestEntries = [{ name: "calliope", node: "m5" }];
    expect(resolveTarget("calliope", config, [])).toMatchObject({ type: "error", reason: "not_found" });

    manifestEntries = [{ name: "calliope", node: "unmapped" }];
    expect(resolveTarget("calliope", config, [])).toMatchObject({ type: "error", reason: "not_found" });
  });

  test("agents map handles self-node, peer, and missing peer URL branches", () => {
    const config: MawConfig = {
      ...CONFIG,
      agents: { localbot: "m5", remotebot: "white", ghostbot: "missing" },
      namedPeers: [{ name: "white", url: "http://white:3456" }],
    };

    expect(resolveTarget("localbot", config, [])).toMatchObject({ type: "error", reason: "self_not_running" });
    expect(resolveTarget("remotebot", config, [])).toEqual({
      type: "peer",
      peerUrl: "http://white:3456",
      target: "remotebot",
      node: "white",
    });
    expect(resolveTarget("ghostbot", config, [])).toMatchObject({ type: "error", reason: "no_peer_url" });
  });
});
