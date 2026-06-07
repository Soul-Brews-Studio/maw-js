import { beforeEach, describe, expect, mock, test } from "bun:test";

const configPath = import.meta.resolve("../../src/config.ts");
const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load.ts");

let config: any;
let savedConfigs: any[] = [];
let fleetReturn: any[] = [];
let fleetError: Error | null = null;
let fetchCalls: string[] = [];
let fetchImpl: any;
let logs: string[] = [];
const originalFetch = globalThis.fetch;
const originalLog = console.log;

mock.module(configPath, () => ({
  loadConfig: () => config,
  saveConfig: (patch: any) => {
    savedConfigs.push(patch);
  },
}));

mock.module(fleetLoadPath, () => ({
  loadFleet: () => {
    if (fleetError) throw fleetError;
    return fleetReturn;
  },
}));

const { cmdFleetInitAgents } = await import("../../src/commands/plugins/fleet/fleet-init-agents.ts?fleet-init-agents-coverage");

function response(ok: boolean, status: number, body: any) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  } as Response;
}

beforeEach(() => {
  config = { agents: {}, namedPeers: [] };
  savedConfigs = [];
  fleetReturn = [];
  fleetError = null;
  fetchCalls = [];
  fetchImpl = async (url: string) => response(true, 200, { agents: {} });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal).toBeDefined();
    fetchCalls.push(String(url));
    return fetchImpl(String(url), init);
  }) as typeof fetch;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

describe("cmdFleetInitAgents coverage", () => {
  test("adds local fleet windows and peer-owned local agents while preserving existing entries", async () => {
    config = {
      agents: { existing: "manual", localKeep: "remote" },
      namedPeers: [
        { name: "white", url: "http://white.local" },
        { name: "mba", url: "http://mba.local" },
        { name: "bad", url: "http://bad.local" },
        { name: "thrower", url: "http://throw.local" },
        { name: "skip-no-url" },
        { url: "http://skip-no-name.local" },
      ],
    };
    fleetReturn = [
      { windows: [{ name: "localKeep" }, { name: "newLocal" }, { name: "" }, null] },
      { windows: undefined },
    ];
    fetchImpl = async (url: string) => {
      if (url.includes("white")) {
        return response(true, 200, {
          agents: {
            peerLocal: "local",
            newLocal: "local",
            remoteView: "mba",
          },
        });
      }
      if (url.includes("mba")) return response(true, 200, { agents: null });
      if (url.includes("bad")) return response(false, 503, {});
      throw new Error("socket closed");
    };

    const result = await cmdFleetInitAgents();

    expect(result).toEqual({
      added: {
        newLocal: "local",
        peerLocal: "white",
      },
      existingPreserved: 2,
      peersReached: 2,
      peersFailed: ["bad (HTTP 503)", "thrower (socket closed)"],
      total: 4,
    });
    expect(fetchCalls).toEqual([
      "http://white.local/api/config",
      "http://mba.local/api/config",
      "http://bad.local/api/config",
      "http://throw.local/api/config",
    ]);
    expect(savedConfigs).toEqual([
      {
        agents: {
          existing: "manual",
          localKeep: "remote",
          newLocal: "local",
          peerLocal: "white",
        },
      },
    ]);
    expect(logs.join("\n")).toContain("peers unreachable: bad (HTTP 503), thrower (socket closed)");
    expect(logs.join("\n")).toContain("wrote 2 new entries");
  });

  test("reports fleet scan failures and dry-run skips writes", async () => {
    config = { agents: {}, namedPeers: [] };
    fleetError = new Error("tmux unavailable");

    const result = await cmdFleetInitAgents({ dryRun: true });

    expect(result).toEqual({
      added: {},
      existingPreserved: 0,
      peersReached: 0,
      peersFailed: [],
      total: 0,
    });
    expect(savedConfigs).toEqual([]);
    expect(logs.join("\n")).toContain("fleet scan failed: tmux unavailable");
    expect(logs.join("\n")).toContain("agents map already in sync");
  });

  test("dry-run with additions renders proposed entries without writing", async () => {
    config = { agents: {}, namedPeers: [] };
    fleetReturn = [{ windows: [{ name: "zeta" }, { name: "alpha" }] }];

    const result = await cmdFleetInitAgents({ dryRun: true });

    expect(result.added).toEqual({ zeta: "local", alpha: "local" });
    expect(savedConfigs).toEqual([]);
    expect(logs.join("\n")).toContain("dry-run:");
    expect(logs.join("\n")).toContain("alpha");
    expect(logs.join("\n")).toContain("zeta");
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
});
