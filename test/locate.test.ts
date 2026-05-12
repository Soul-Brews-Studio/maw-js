/**
 * locate — cmdLocate DI-testable unit tests.
 *
 * Uses LocateDeps injection — no mock.module calls needed.
 * Pattern mirrors federation-agents.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cmdLocate, type LocateDeps } from "../src/commands/shared/locate";
import type { FederationAgent } from "../src/commands/shared/federation-agents";

type FetchFn = LocateDeps["fetch"];

function makeFetch(responses: Record<string, { ok: boolean; status: number; data: unknown }>): FetchFn {
  return async (url) => responses[url] ?? { ok: false, status: 0, data: null };
}

function makeLocalAgents(node: string, agents: Omit<FederationAgent, "node">[]): LocateDeps["getLocalAgents"] {
  return async () => agents.map(a => ({ ...a, node }));
}

const voltAgent: Omit<FederationAgent, "node"> = {
  oracle: "volt",
  session: "36-volt",
  window: "volt-oracle",
  state: "active",
};

let output: string[] = [];
const origLog = console.log;

beforeEach(() => {
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = origLog;
});

function baseDeps(overrides: Partial<LocateDeps> = {}): Partial<LocateDeps> {
  return {
    getLocalAgents: makeLocalAgents("m5", [voltAgent]),
    peers: () => [],
    namedPeers: () => [],
    nodeName: () => "m5",
    fetch: makeFetch({}),
    configAgentsMap: () => ({ volt: "m5" }),
    ...overrides,
  };
}

describe("cmdLocate", () => {
  test("shows local agent + config node", async () => {
    await cmdLocate("volt", {}, baseDeps());

    const all = output.join("\n");
    expect(all).toContain("📍 volt");
    expect(all).toContain("m5 (from config.agents)");
    expect(all).toContain("36-volt");
    expect(all).toContain("active");
  });

  test("shows federation results from peer", async () => {
    await cmdLocate("volt", {}, baseDeps({
      getLocalAgents: makeLocalAgents("m5", []),
      peers: () => ["http://white:3456"],
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "volt", session: "05-volt", window: "volt-oracle", state: "active" }] },
        },
      }),
    }));

    const all = output.join("\n");
    expect(all).toContain("📍 volt");
    expect(all).toContain("white");
    expect(all).toContain("05-volt");
  });

  test("local + peer both running: both shown", async () => {
    await cmdLocate("volt", {}, baseDeps({
      peers: () => ["http://white:3456"],
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "volt", session: "05-volt", window: "volt-oracle", state: "active" }] },
        },
      }),
    }));

    const all = output.join("\n");
    expect(all).toContain("36-volt");
    expect(all).toContain("05-volt");
    expect(all).toContain("m5");
    expect(all).toContain("white");
  });

  test("oracle not in config.agents: shows fallback text", async () => {
    await cmdLocate("unknown-oracle", {}, baseDeps({
      getLocalAgents: makeLocalAgents("m5", []),
      configAgentsMap: () => ({}),
    }));

    const all = output.join("\n");
    expect(all).toContain("📍 unknown-oracle");
    expect(all).toContain("not in config.agents");
    expect(all).toContain("not running anywhere");
  });

  test("oracle not running anywhere: shows not running message", async () => {
    await cmdLocate("volt", {}, baseDeps({
      getLocalAgents: makeLocalAgents("m5", [
        { oracle: "other", session: "01-other", window: "other-oracle", state: "active" },
      ]),
    }));

    const all = output.join("\n");
    expect(all).toContain("not running anywhere in federation");
  });

  test("peer unreachable: warning shown, local still renders", async () => {
    await cmdLocate("volt", {}, baseDeps({
      peers: () => ["http://clinic-nat:3456"],
      namedPeers: () => [{ name: "clinic-nat", url: "http://clinic-nat:3456" }],
      fetch: async () => { throw new Error("timeout"); },
    }));

    const all = output.join("\n");
    expect(all).toContain("36-volt");
    expect(all).toContain("clinic-nat");
    expect(all).toContain("timeout");
  });

  test("--json shape contract", async () => {
    await cmdLocate("volt", { json: true }, baseDeps({
      peers: () => ["http://white:3456"],
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "volt", session: "05-volt", window: "volt-oracle", state: "idle" }] },
        },
      }),
    }));

    const raw = output.join("\n");
    const parsed = JSON.parse(raw);
    expect(parsed.query).toBe("volt");
    expect(parsed.config).toEqual({ node: "m5" });
    expect(Array.isArray(parsed.federation)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    expect(parsed.federation.length).toBe(2);

    const local = parsed.federation.find((a: FederationAgent) => a.node === "m5");
    expect(local?.session).toBe("36-volt");

    const remote = parsed.federation.find((a: FederationAgent) => a.node === "white");
    expect(remote?.session).toBe("05-volt");
  });

  test("--json with missing config entry: config is null", async () => {
    await cmdLocate("ghost", { json: true }, baseDeps({
      getLocalAgents: makeLocalAgents("m5", []),
      configAgentsMap: () => ({}),
    }));

    const parsed = JSON.parse(output.join("\n"));
    expect(parsed.query).toBe("ghost");
    expect(parsed.config).toBeNull();
    expect(parsed.federation).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  test("query is case-insensitive: 'Volt' matches 'volt' agents", async () => {
    await cmdLocate("Volt", {}, baseDeps());

    const all = output.join("\n");
    expect(all).toContain("📍 Volt");
    expect(all).toContain("36-volt");
  });

  test("non-matching agents not shown", async () => {
    await cmdLocate("volt", {}, baseDeps({
      getLocalAgents: makeLocalAgents("m5", [
        voltAgent,
        { oracle: "matrix", session: "10-matrix", window: "matrix-oracle", state: "active" },
      ]),
    }));

    const all = output.join("\n");
    expect(all).toContain("36-volt");
    expect(all).not.toContain("matrix");
  });
});
