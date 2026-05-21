import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import type { DiscoveryError, DiscoveryResponse } from "../../src/vendor/mpr-plugins/peers/discovered";
import type { LoadedPlugin } from "../../src/plugin/types";
import type { FleetEntry } from "../../src/commands/shared/fleet-load";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";

const configPath = import.meta.resolve("../../src/config");
const discoveredPath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/discovered");
const liveStatePath = import.meta.resolve("../../src/commands/shared/discover-live-state");
const registryPath = import.meta.resolve("../../src/plugin/registry");
const repoDiscoveryPath = import.meta.resolve("../../src/core/repo-discovery");
const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load");
const oracleManifestPath = import.meta.resolve("../../src/lib/oracle-manifest");

let configValue: Record<string, unknown> = {};
let discoveryResult: DiscoveryResponse | DiscoveryError;
let fetchCalls: Array<Record<string, unknown> | undefined> = [];
let liveCalls: unknown[] = [];
let liveStateResult: {
  source: "tmux";
  live: Array<{
    source: "tmux";
    id: string;
    target: string;
    session: string;
    window: string;
    pane: string;
    command?: string;
    cwd?: string;
    awake: true;
    matches: string[];
  }>;
  warnings: string[];
};
let pluginRows: LoadedPlugin[] = [];
let pluginError: Error | null = null;
let ghqPaths: string[] = [];
let ghqError: Error | null = null;
let fleetEntries: FleetEntry[] = [];
let fleetError: Error | null = null;
let manifestRows: OracleManifestEntry[] = [];
let manifestError: Error | null = null;

mock.module(configPath, () => ({
  ...mockConfigModule(() => configValue as never),
}));

mock.module(discoveredPath, () => ({
  fetchDiscoveries: async (opts?: Record<string, unknown>) => {
    fetchCalls.push(opts);
    return discoveryResult;
  },
}));

mock.module(liveStatePath, () => ({
  resolveTmuxLiveState: async (peers: Array<Record<string, unknown>>) => {
    liveCalls.push(peers);
    return liveStateResult;
  },
  markPeerTargetsLive: (peers: Array<Record<string, unknown>>, live: Array<Record<string, unknown>>) => peers.map((peer) => {
    const signals = new Set([peer.name, peer.node, peer.oracle, peer.url].filter(Boolean));
    const matching = live.filter((pane) => Array.isArray(pane.matches) && pane.matches.some((match) => signals.has(match)));
    return {
      ...peer,
      awake: matching.length > 0,
      liveTargets: matching.map((pane) => pane.target),
      liveSessions: [...new Set(matching.map((pane) => pane.session))],
    };
  }),
  formatTmuxLiveState: (result: { live: Array<Record<string, unknown>>; warnings: string[] }) =>
    result.live.length > 0
      ? result.live.map((pane) => `tmux ${pane.session}:${pane.window}.${pane.pane} ${pane.command ?? "-"}`).join("\n")
      : `no live tmux sessions/windows found${result.warnings.length ? `\nwarning: ${result.warnings.join(",")}` : ""}`,
}));

mock.module(registryPath, () => ({
  discoverPackages: () => {
    if (pluginError) throw pluginError;
    return pluginRows;
  },
}));

mock.module(repoDiscoveryPath, () => ({
  getRepos: () => ({
    name: "ghq",
    list: async () => {
      if (ghqError) throw ghqError;
      return ghqPaths;
    },
    listSync: () => ghqPaths,
    findBySuffix: async () => null,
    findBySuffixSync: () => null,
  }),
}));

mock.module(fleetLoadPath, () => ({
  loadFleetEntries: () => {
    if (fleetError) throw fleetError;
    return fleetEntries;
  },
}));

mock.module(oracleManifestPath, () => ({
  loadManifestCached: () => {
    if (manifestError) throw manifestError;
    return manifestRows;
  },
}));

const { command, default: handler } = await import("../../src/commands/plugins/discover/index.ts?discover-plugin-peer-sources");

function discovery(url: string, node = "scout-node"): DiscoveryResponse {
  return {
    ok: true,
    total: 1,
    shown: 1,
    filtered: false,
    peers: [{
      zid: "z1",
      node,
      oracle: "mawjs",
      host: "scout-host",
      locators: [url],
      capabilities: ["send"],
      oracles: ["mawjs"],
      firstSeen: "2026-05-20T00:00:00.000Z",
      lastSeen: "2026-05-20T00:00:01.000Z",
      seenRel: "now",
      paired: false,
    }],
  };
}

function plugin(name: string, overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.2.3",
      sdk: "^1.0.0",
      tier: "standard",
      weight: 12,
      cli: { command: name, aliases: [`${name}-alias`] },
      capabilities: ["sdk:identity"],
      dependencies: { plugins: ["base"] },
    },
    dir: `/plugins/${name}`,
    wasmPath: "",
    entryPath: `/plugins/${name}/index.ts`,
    kind: "ts",
    ...overrides,
  };
}

function fleetEntry(name: string, windows: FleetEntry["session"]["windows"], overrides: Partial<FleetEntry> = {}): FleetEntry {
  return {
    file: `50-${name}.json`,
    num: 50,
    groupName: name,
    session: {
      name: `50-${name}`,
      windows,
    },
    ...overrides,
  };
}

function oracle(name: string, overrides: Partial<OracleManifestEntry> = {}): OracleManifestEntry {
  return {
    name,
    sources: ["oracles-json"],
    repo: `Soul-Brews-Studio/${name}-oracle`,
    localPath: `/opt/Code/github.com/Soul-Brews-Studio/${name}-oracle`,
    hasPsi: true,
    hasFleetConfig: false,
    isLive: false,
    ...overrides,
  };
}

beforeEach(() => {
  configValue = {
    peers: ["http://config:3456"],
    namedPeers: [{ name: "named", url: "http://named:3456" }],
  };
  discoveryResult = discovery("http://scout:3456");
  fetchCalls = [];
  liveCalls = [];
  liveStateResult = {
    source: "tmux",
    live: [{
      source: "tmux",
      id: "%1",
      target: "101-mawjs:agent.0",
      session: "101-mawjs",
      window: "agent",
      pane: "0",
      command: "claude",
      cwd: "/repo/mawjs-oracle",
      awake: true,
      matches: ["named"],
    }],
    warnings: [],
  };
  pluginRows = [];
  pluginError = null;
  ghqPaths = [];
  ghqError = null;
  fleetEntries = [];
  fleetError = null;
  manifestRows = [];
  manifestError = null;
});

describe("discover plugin peer-source integration (#1808, #1831)", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "discover",
      description: "List configured/discovered federation peers, inventory sources, and live tmux state.",
    });
  });

  test("rejects invalid peer-source mode before loading peers", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "bogus"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "invalid_peer_source",
      output: "usage: maw discover [--peers config|scout|both] [--json] [--tree] [--awake]",
    });
    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toEqual([]);
  });

  test("renders text output for inline scout mode without probing tmux", async () => {
    const result = await handler({ source: "cli", args: ["--peers=scout"] } as any);

    expect(fetchCalls).toEqual([{ all: true }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("scout-node");
    expect(result.output).toContain("http://scout:3456");
    expect(liveCalls).toEqual([]);
  });

  test("renders config-only JSON with live peer metadata without calling scout", async () => {
    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toHaveLength(1);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.mode).toBe("config");
    expect(parsed.total).toBe(2);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
    expect(parsed.live.sessions[0].name).toBe("101-mawjs");
    expect(parsed.plugins).toEqual({
      source: "plugin-registry",
      total: 0,
      records: [],
    });
    expect(parsed.fleet).toEqual({
      source: "fleet-config",
      total: 0,
      records: [],
    });
    expect(parsed.oracles).toEqual({
      source: "oracle-manifest",
      total: 0,
      records: [],
    });
    expect(parsed.ghq).toEqual({
      source: "ghq",
      total: 0,
      repos: [],
    });
    expect(parsed.peers.find((peer: { name?: string }) => peer.name === "named").awake).toBe(true);
    expect(parsed.peers.map((peer: { url: string }) => peer.url)).toEqual(["http://config:3456", "http://named:3456"]);
  });

  test("API source writes JSON and defaults to both mode", async () => {
    const writes: string[] = [];

    const result = await handler({
      source: "api",
      args: { json: true },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(fetchCalls).toEqual([{ all: true }]);
    expect(liveCalls).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.mode).toBe("both");
    expect(parsed.total).toBe(3);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.peers.find((peer: { name?: string }) => peer.name === "named").awake).toBe(true);
  });

  test("API source accepts string false json and renders warnings in text", async () => {
    const writes: string[] = [];
    discoveryResult = {
      ok: false,
      error: "daemon_unreachable",
      hint: "is maw serve running?",
    };

    const result = await handler({
      source: "api",
      args: { peers: "both", json: "off" },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(liveCalls).toEqual([]);
    expect(writes.join("\n")).toContain("warning: scout unavailable");
  });

  test("includes registered plugins in JSON output without changing peer totals", async () => {
    pluginRows = [plugin("buddy")];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.total).toBe(2);
    expect(parsed.plugins.records).toEqual([{
      source: "plugin-registry",
      type: "plugin",
      name: "buddy",
      version: "1.2.3",
      kind: "ts",
      tier: "standard",
      weight: 12,
      disabled: false,
      dir: "/plugins/buddy",
      command: "buddy",
      aliases: ["buddy-alias"],
      capabilities: ["sdk:identity"],
      dependencies: ["base"],
    }]);
  });

  test("includes deduped fleet config workspaces in JSON and tree output", async () => {
    configValue = {
      namedPeers: [
        { name: "m5", url: "http://m5:3456" },
        { name: "white", url: "http://white:3456" },
      ],
      agents: {
        "mawjs-oracle": "m5",
        "white-oracle": "white",
      },
      node: "m5",
    };
    fleetEntries = [
      fleetEntry("mawjs", [
        { name: "mawjs-oracle", repo: "Soul-Brews-Studio/maw-js" },
        { name: "white-oracle", repo: "Soul-Brews-Studio/white-oracle" },
      ]),
      fleetEntry("mawjs-dupe", [
        { name: "mawjs-oracle", repo: "Soul-Brews-Studio/maw-js" },
      ], { file: "51-mawjs-dupe.json", num: 51, groupName: "mawjs-dupe" }),
    ];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.fleet.total).toBe(2);
    expect(parsed.fleet.records).toEqual([
      {
        source: "fleet-config",
        type: "workspace",
        file: "50-mawjs.json",
        slot: 50,
        groupName: "mawjs",
        session: "50-mawjs",
        name: "mawjs-oracle",
        repo: "Soul-Brews-Studio/maw-js",
        node: "m5",
        endpoint: "http://m5:3456",
        peerMatched: true,
      },
      {
        source: "fleet-config",
        type: "workspace",
        file: "50-mawjs.json",
        slot: 50,
        groupName: "mawjs",
        session: "50-mawjs",
        name: "white-oracle",
        repo: "Soul-Brews-Studio/white-oracle",
        node: "white",
        endpoint: "http://white:3456",
        peerMatched: true,
      },
    ]);
    expect(parsed.tree.fleet.map((record: { name: string }) => record.name)).toEqual(["mawjs-oracle", "white-oracle"]);
  });

  test("renders fleet config text with configured-but-offline workspaces", async () => {
    configValue = {
      peers: [],
      namedPeers: [],
      agents: { "offline-oracle": "white" },
    };
    fleetEntries = [fleetEntry("offline", [{ name: "offline-oracle", repo: "Soul-Brews-Studio/offline-oracle" }])];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet config");
    expect(result.output).toContain("offline-oracle");
    expect(result.output).toContain("offline");
  });

  test("includes registered oracle inventory joined with ghq, fleet, and peers", async () => {
    configValue = {
      namedPeers: [{ name: "mawjs", url: "http://m5:3456" }],
      agents: { "mawjs-oracle": "m5" },
    };
    ghqPaths = ["/opt/Code/github.com/Soul-Brews-Studio/maw-js"];
    fleetEntries = [fleetEntry("mawjs", [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/maw-js" }])];
    manifestRows = [
      oracle("mawjs", {
        sources: ["fleet", "agent", "oracles-json"],
        node: "m5",
        session: "50-mawjs",
        window: "mawjs-oracle",
        repo: "Soul-Brews-Studio/maw-js",
        localPath: "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
        hasFleetConfig: true,
      }),
    ];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.oracles.total).toBe(1);
    expect(parsed.oracles.records).toEqual([{
      source: "oracle-manifest",
      type: "oracle",
      name: "mawjs",
      sources: ["fleet", "agent", "oracles-json"],
      node: "m5",
      session: "50-mawjs",
      window: "mawjs-oracle",
      repo: "Soul-Brews-Studio/maw-js",
      localPath: "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      hasPsi: true,
      hasFleetConfig: true,
      awake: false,
      ghqPath: "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      worktree: false,
      fleetMatched: true,
      peerUrls: ["http://m5:3456"],
    }]);
  });

  test("dedupes duplicate registered oracle rows and joins tmux evidence in tree output", async () => {
    manifestRows = [
      oracle("mawjs", { sources: ["oracles-json"], window: "mawjs-oracle" }),
      oracle("mawjs", { sources: ["fleet"], window: "mawjs-oracle" }),
    ];
    liveStateResult = {
      source: "tmux",
      live: [{
        source: "tmux",
        id: "%9",
        target: "50-mawjs:mawjs-oracle.0",
        session: "50-mawjs",
        window: "mawjs-oracle",
        pane: "0",
        command: "claude",
        awake: true,
        matches: ["mawjs"],
      }],
      warnings: [],
    };

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.oracles.total).toBe(1);
    expect(parsed.tree.oracles).toHaveLength(1);
    expect(parsed.tree.oracles[0].awake).toBe(true);
  });

  test("joins registered oracles to ghq by repo slug and oracle name variants", async () => {
    ghqPaths = [
      "/opt/Code/github.com/Soul-Brews-Studio/repo-join",
      "/opt/Code/github.com/Soul-Brews-Studio/variant-oracle",
    ];
    manifestRows = [
      oracle("repojoin", {
        repo: "Soul-Brews-Studio/repo-join",
        localPath: undefined,
      }),
      oracle("variant", {
        repo: undefined,
        localPath: undefined,
      }),
    ];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.oracles.records.map((record: { ghqPath?: string }) => record.ghqPath)).toEqual([
      "/opt/Code/github.com/Soul-Brews-Studio/repo-join",
      "/opt/Code/github.com/Soul-Brews-Studio/variant-oracle",
    ]);
  });

  test("renders registered oracle inventory in text output", async () => {
    manifestRows = [oracle("mother")];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registered oracles");
    expect(result.output).toContain("mother");
    expect(result.output).toContain("oracles-json");
  });

  test("renders plugin registry in text output", async () => {
    pluginRows = [plugin("handover", { disabled: true })];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plugin registry");
    expect(result.output).toContain("handover");
    expect(result.output).toContain("disabled");
    expect(liveCalls).toEqual([]);
  });

  test("includes deduped ghq repos in JSON and tree output", async () => {
    ghqPaths = [
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
    ];

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.ghq.total).toBe(2);
    expect(parsed.ghq.repos).toEqual([
      {
        source: "ghq",
        type: "repo",
        path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
        name: "maw-js",
        owner: "Soul-Brews-Studio",
        host: "github.com",
        oracleLike: false,
        worktree: false,
      },
      {
        source: "ghq",
        type: "repo",
        path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
        name: "maw-js.wt-features",
        owner: "Soul-Brews-Studio",
        host: "github.com",
        oracleLike: false,
        worktree: true,
      },
    ]);
    expect(parsed.tree.ghq.map((repo: { path: string }) => repo.path)).toEqual([
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js",
      "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-features",
    ]);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
  });

  test("renders ghq repos in text output", async () => {
    ghqPaths = ["/opt/Code/github.com/Soul-Brews-Studio/mother-oracle"];

    const result = await handler({ source: "cli", args: ["--peers=config"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ghq repos");
    expect(result.output).toContain("mother-oracle");
    expect(result.output).toContain("yes");
    expect(liveCalls).toEqual([]);
  });

  test("renders discover tree with pane-level tmux live-state in JSON", async () => {
    liveStateResult = {
      source: "tmux",
      live: [
        {
          source: "tmux",
          id: "%1",
          target: "50-mawjs:mawjs-oracle.0",
          session: "50-mawjs",
          window: "mawjs-oracle",
          pane: "0",
          command: "claude",
          awake: true,
          matches: ["mawjs"],
        },
        {
          source: "tmux",
          id: "%2",
          target: "50-mawjs:mawjs-codex.0",
          session: "50-mawjs",
          window: "mawjs-codex",
          pane: "0",
          command: "codex",
          awake: true,
          matches: [],
        },
      ],
      warnings: [],
    };

    const result = await handler({
      source: "cli",
      args: ["--peers", "both", "--json", "--tree", "--awake"],
    } as any);

    expect(fetchCalls).toEqual([{ all: true }]);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.mode).toBe("both");
    expect(parsed.awake).toBe(true);
    expect(parsed.total).toBe(5);
    expect(parsed.plugins).toEqual({
      source: "plugin-registry",
      total: 0,
      records: [],
    });
    expect(parsed.fleet).toEqual({
      source: "fleet-config",
      total: 0,
      records: [],
    });
    expect(parsed.oracles).toEqual({
      source: "oracle-manifest",
      total: 0,
      records: [],
    });
    expect(parsed.ghq).toEqual({
      source: "ghq",
      total: 0,
      repos: [],
    });
    expect(parsed.live.total).toBe(2);
    expect(parsed.live.sessions[0].name).toBe("50-mawjs");
    expect(parsed.live.sessions[0].windows.map((window: { name: string }) => window.name)).toEqual([
      "mawjs-oracle",
      "mawjs-codex",
    ]);
    expect(parsed.tree.live[0].name).toBe("50-mawjs");
    expect(parsed.tree.peers.map((peer: { url: string }) => peer.url)).toEqual([
      "http://config:3456",
      "http://named:3456",
      "http://scout:3456",
    ]);
  });

  test("renders tree text with plugin and ghq live inventory rows", async () => {
    pluginRows = [plugin("handover", { disabled: true })];
    ghqPaths = ["/opt/Code/github.com/Soul-Brews-Studio/mother-oracle.wt-review"];
    configValue = {
      namedPeers: [{ name: "m5", url: "http://m5:3456" }],
      agents: { "handover-oracle": "m5" },
    };
    fleetEntries = [fleetEntry("handover", [{ name: "handover-oracle", repo: "Soul-Brews-Studio/handover-oracle" }])];
    manifestRows = [
      oracle("mother", {
        repo: "Soul-Brews-Studio/mother-oracle",
        localPath: "/opt/Code/github.com/Soul-Brews-Studio/mother-oracle.wt-review",
      }),
    ];
    liveStateResult = {
      source: "tmux",
      live: [{
        source: "tmux",
        id: "%8",
        target: "50-mother:mother-oracle.0",
        session: "50-mother",
        window: "mother-oracle",
        pane: "0",
        command: "claude",
        awake: true,
        matches: ["mother"],
      }],
      warnings: [],
    };

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet config (1 configured)");
    expect(result.output).toContain("m5/handover-oracle 50-handover endpoint=http://m5:3456 repo=Soul-Brews-Studio/handover-oracle");
    expect(result.output).toContain("registered oracles (1)");
    expect(result.output).toContain("mother awake sources=oracles-json repo=Soul-Brews-Studio/mother-oracle ghq=/opt/Code/github.com/Soul-Brews-Studio/mother-oracle.wt-review");
    expect(result.output).toContain("plugins (1 registered)");
    expect(result.output).toContain("handover@1.2.3 ts/standard command=handover disabled");
    expect(result.output).toContain("ghq (1 repos)");
    expect(result.output).toContain("mother-oracle.wt-review oracle-like worktree");
  });

  test("renders awake-only text from tmux panes without loading peers", async () => {
    const result = await handler({ source: "cli", args: ["--awake"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual([]);
    expect(liveCalls).toEqual([[]]);
    expect(result.output).toContain("tmux 101-mawjs:agent.0 claude");
    expect(result.output).not.toContain("http://config:3456");
  });

  test("awake JSON filters peer rows to live matches while preserving live panes", async () => {
    const result = await handler({ source: "cli", args: ["--awake", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.awake).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.peers.map((peer: { name?: string }) => peer.name)).toEqual(["named"]);
    expect(parsed.liveTotal).toBe(1);
    expect(parsed.live.panes[0].target).toBe("101-mawjs:agent.0");
    expect(parsed.plugins.records).toEqual([]);
    expect(parsed.ghq.repos).toEqual([]);
  });

  test("renders awake JSON with tmux warning when live-state is unavailable", async () => {
    liveStateResult = {
      source: "tmux",
      live: [],
      warnings: ["tmux unavailable (tmux missing)"],
    };

    const result = await handler({ source: "cli", args: ["--awake", "--json"] } as any);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.live.total).toBe(0);
    expect(parsed.live.sessions).toEqual([]);
    expect(parsed.warnings).toContain("tmux unavailable (tmux missing)");
  });

  test("renders plugin registry warnings in tree output without crashing", async () => {
    pluginError = new Error("bad registry");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plugins (0 registered)");
    expect(result.output).toContain("warning: plugin registry unavailable (bad registry)");
  });

  test("renders fleet config warnings in tree output without crashing", async () => {
    fleetError = new Error("fleet missing");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet config (0 configured)");
    expect(result.output).toContain("warning: fleet config unavailable (fleet missing)");
  });

  test("renders oracle registry warnings in tree output without crashing", async () => {
    manifestError = new Error("manifest missing");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registered oracles (0)");
    expect(result.output).toContain("warning: oracle registry unavailable (manifest missing)");
  });

  test("renders ghq warnings in tree output without crashing", async () => {
    ghqError = new Error("ghq missing");

    const result = await handler({ source: "cli", args: ["--peers", "config", "--tree"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("ghq (0 repos)");
    expect(result.output).toContain("warning: ghq unavailable (ghq missing)");
  });
});
