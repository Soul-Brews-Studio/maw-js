import { describe, expect, mock, test } from "bun:test";
import { PassThrough } from "stream";
import type { MawConfig } from "../../src/config";
import type { Session } from "../../src/core/runtime/find-window";

let fleetMap: Record<string, string | null> = {};
let manifestEntries: Array<{ name: string; node?: string }> = [];
let manifestThrows = false;
let ghqRepos: string[] = [];

mock.module(import.meta.resolve("../../src/core/runtime/find-window"), () => ({
  findWindow: (sessions: Session[], query: string): string | null => {
    for (const session of sessions) {
      const byWindow = session.windows.find((window) => window.name === query);
      if (byWindow) return `${session.name}:${byWindow.index}`;
      if (session.name === query && session.windows[0]) return `${session.name}:${session.windows[0].index}`;
    }
    return null;
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  resolveFleetSession: (query: string) => fleetMap[query] ?? null,
}));

mock.module(import.meta.resolve("../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => {
    if (manifestThrows) throw new Error("manifest unavailable");
    return manifestEntries;
  },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async () => "",
  ghqList: async () => ghqRepos,
}));

const routing = await import("../../src/core/routing.ts?coverage-next-core-routing-resolve");
const sharedResolve = await import("../../src/core/resolve.ts?coverage-next-core-routing-resolve");

function config(overrides: Partial<MawConfig> = {}): MawConfig {
  return {
    host: "local",
    port: 3456,
    ghqRoot: "/gh",
    oracleUrl: "http://127.0.0.1:3456",
    env: {},
    commands: {},
    sessions: {},
    node: "m5",
    namedPeers: [],
    peers: [],
    agents: {},
    ...overrides,
  } as MawConfig;
}

function session(name: string, windows: Array<{ index: number; name: string }>, source?: string): Session & { source?: string } {
  return { name, windows: windows.map((window) => ({ ...window, active: false })), source };
}

describe("coverage next core routing", () => {
  test("prefers fleet and session alias windows before generic window fallback", () => {
    fleetMap = { atlas: "42-atlas" };
    manifestEntries = [];
    manifestThrows = false;

    expect(routing.resolveTarget("atlas", config(), [
      session("42-atlas", [{ index: 1, name: "helper" }, { index: 2, name: "atlas-oracle" }]),
    ])).toEqual({ type: "local", target: "42-atlas:2" });

    fleetMap = { solo: "43-solo" };
    expect(routing.resolveTarget("solo", config(), [
      session("43-solo", [{ index: 7, name: "console" }]),
    ])).toEqual({ type: "local", target: "43-solo:7" });

    fleetMap = { willow: "44-willow" };
    expect(routing.resolveTarget("willow", config(), [
      session("44-willow", [{ index: 1, name: "helper" }, { index: 2, name: "scratch" }]),
    ])).toMatchObject({ type: "error", reason: "fleet_window_not_found" });
  });

  test("filters non-writable sessions and handles session alias ambiguity", () => {
    fleetMap = {};
    manifestEntries = [];

    expect(routing.resolveTarget("ghost", config(), [
      session("ghost-view", [{ index: 1, name: "ghost" }]),
      session("remote-ghost", [{ index: 1, name: "ghost" }], "peer"),
    ])).toMatchObject({ type: "error", reason: "not_found" });

    expect(routing.resolveTarget("cedar", config(), [
      session("10-cedar", [{ index: 1, name: "shell" }]),
      session("11-cedar", [{ index: 1, name: "shell" }]),
    ])).toMatchObject({ type: "error", reason: "session_alias_ambiguous" });

    expect(routing.resolveTarget("spruce", config(), [
      session("70-spruce-oracle", [{ index: 1, name: "spruce-oracle" }]),
      session("69-spruce", [{ index: 3, name: "shell" }]),
    ])).toEqual({ type: "local", target: "69-spruce:3" });
  });

  test("resolves explicit nodes, manifest peers, and agents map edge paths", () => {
    fleetMap = {};
    manifestEntries = [{ name: "manifested", node: "remote" }];

    const cfg = config({
      namedPeers: [{ name: "remote", url: "http://remote.local:3456" }],
      peers: ["http://legacy-node.local:3456"],
      agents: { remoteAgent: "remote", localAgent: "m5", unknownAgent: "missing-node" },
    });

    expect(routing.resolveTarget("remote:worker", cfg, [])).toEqual({
      type: "peer",
      peerUrl: "http://remote.local:3456",
      target: "worker",
      node: "remote",
    });
    expect(routing.resolveTarget("legacy-node:worker", cfg, [])).toEqual({
      type: "peer",
      peerUrl: "http://legacy-node.local:3456",
      target: "worker",
      node: "legacy-node",
    });
    expect(routing.resolveTarget("m5:missing", cfg, [])).toMatchObject({ type: "error", reason: "self_not_running" });
    expect(routing.resolveTarget(":missing", cfg, [])).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
    expect(routing.resolveTarget("unknown:worker", cfg, [])).toMatchObject({ type: "error", reason: "unknown_node" });
    expect(routing.resolveTarget("manifested", cfg, [])).toEqual({
      type: "peer",
      peerUrl: "http://remote.local:3456",
      target: "manifested",
      node: "remote",
    });
    expect(routing.resolveTarget("remoteAgent", cfg, [])).toMatchObject({ type: "peer", node: "remote" });
    expect(routing.resolveTarget("localAgent", cfg, [])).toMatchObject({ type: "error", reason: "self_not_running" });
    expect(routing.resolveTarget("unknownAgent", cfg, [])).toMatchObject({ type: "error", reason: "no_peer_url" });

    manifestThrows = true;
    expect(routing.resolveTarget("manifested", cfg, [])).toMatchObject({ type: "error", reason: "not_found" });
    manifestThrows = false;
  });
});

describe("coverage next core oracle resolver", () => {
  test("resolves supplied repo lists across exact, prefix, substring, and namespace paths", async () => {
    const repos = [
      "/gh/Org/alpha-oracle",
      "/gh/Other/alpha-oracle",
      "/gh/Org/alpine-oracle",
      "/gh/Org/not-an-oracle",
    ];

    await expect(sharedResolve.resolveOracle("alpha", {
      nameSpace: "session",
      matchPolicy: "exact",
      repos,
    })).resolves.toEqual({ kind: "not-found" });

    await expect(sharedResolve.resolveOracle("Org/alpha", {
      nameSpace: "oracle",
      matchPolicy: "exact",
      repos: async () => repos,
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "Org", repo: "alpha-oracle", path: "/gh/Org/alpha-oracle" },
    });

    await expect(sharedResolve.resolveOracle("Org/al", {
      nameSpace: "oracle",
      matchPolicy: "prefix",
      repos,
    })).resolves.toMatchObject({ kind: "ambiguous" });

    await expect(sharedResolve.resolveOracle("Org/", {
      nameSpace: "oracle",
      matchPolicy: "substring",
      repos,
    })).resolves.toEqual({ kind: "not-found" });

    const fuzzy = await sharedResolve.resolveOracle("42-alpha", {
      nameSpace: "oracle",
      matchPolicy: "substring",
      repos,
      pwdHint: { owner: "Other", repo: "alpha-oracle" },
    });
    expect(fuzzy).toMatchObject({ kind: "ambiguous" });
    if (fuzzy.kind === "ambiguous") expect(fuzzy.candidates[0]).toMatchObject({ owner: "Other" });
  });

  test("dedupes ghq results and reads picker choices from injected streams", async () => {
    ghqRepos = ["/gh/Org/opal-oracle", "/gh/Org/opal-oracle", "/gh/Org/opal-helper"];

    await expect(sharedResolve.resolveOracle("opal", {
      nameSpace: "any",
      matchPolicy: "exact",
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "Org", repo: "opal-oracle", path: "/gh/Org/opal-oracle" },
    });

    expect(sharedResolve._test.normalizedIntentNames("07-Opal-Oracle")).toEqual(["07-opal-oracle", "07-opal", "opal-oracle", "opal"]);
    expect(sharedResolve._test.oracleRefFromPath("C:\\gh\\Org\\notmatching")).toBeNull();

    const reader = new PassThrough() as NodeJS.ReadStream;
    const writes: string[] = [];
    const selected = sharedResolve.pickOracle([
      { owner: "Org", repo: "one-oracle", path: "/gh/Org/one-oracle" },
      { owner: "Org", repo: "two-oracle", path: "/gh/Org/two-oracle" },
    ], {
      stream: { write: (text: string) => { writes.push(text); return true; } },
      reader,
    });
    reader.end("2");

    await expect(selected).resolves.toEqual({ owner: "Org", repo: "two-oracle", path: "/gh/Org/two-oracle" });
    expect(writes.join("")).toContain("Select [1-2]");
    expect(reader.listenerCount("data")).toBe(0);
    expect(reader.listenerCount("end")).toBe(0);
  });
});
