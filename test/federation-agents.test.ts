/**
 * federation-agents — cmdFederationAgents DI-testable unit tests.
 *
 * Uses FederationAgentDeps injection so no mock.module calls are needed.
 * Pattern mirrors federation-symmetric.test.ts to avoid cross-file wrapper layering.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cmdFederationAgents, type FederationAgent, type FederationAgentDeps } from "../src/commands/shared/federation-agents";

type FetchFn = FederationAgentDeps["fetch"];

function makeFetch(responses: Record<string, { ok: boolean; status: number; data: unknown }>): FetchFn {
  return async (url) => responses[url] ?? { ok: false, status: 0, data: null };
}

function makeLocalAgents(node: string, agents: Omit<FederationAgent, "node">[]): FederationAgentDeps["getLocalAgents"] {
  return async () => agents.map(a => ({ ...a, node }));
}

const localAgent: Omit<FederationAgent, "node"> = {
  oracle: "volt",
  session: "36-volt",
  window: "volt-oracle",
  state: "active",
};

// Capture console output
let output: string[] = [];
const origLog = console.log;

beforeEach(() => {
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = origLog;
});

describe("cmdFederationAgents", () => {
  test("happy path: local + 2 peers, merged table", async () => {
    const peers = ["http://white:3456", "http://mba:3456"];
    await cmdFederationAgents({ json: false }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [
        { name: "white", url: "http://white:3456" },
        { name: "mba", url: "http://mba:3456" },
      ],
      nodeName: () => "m5",
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "mother", session: "14-mother", window: "mother-oracle", state: "idle" }] },
        },
        "http://mba:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "mba", oracle: "pigment", session: "04-pigment", window: "pigment-oracle", state: "idle" }] },
        },
      }),
    });

    const all = output.join("\n");
    expect(all).toContain("volt");
    expect(all).toContain("mother");
    expect(all).toContain("pigment");
    expect(all).toContain("m5 (local)");
    expect(all).toContain("white");
    expect(all).toContain("mba");
    // no skipped warning
    expect(all).not.toContain("unreachable");
  });

  test("single peer timeout: warning shown, table still renders", async () => {
    const peers = ["http://white:3456", "http://clinic-nat:3456"];
    await cmdFederationAgents({ json: false }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [
        { name: "white", url: "http://white:3456" },
        { name: "clinic-nat", url: "http://clinic-nat:3456" },
      ],
      nodeName: () => "m5",
      fetch: async (url) => {
        if (url.startsWith("http://clinic-nat")) throw new Error("timeout");
        return { ok: true, status: 200, data: { agents: [{ node: "white", oracle: "neo", session: "02-neo", window: "neo-oracle", state: "active" }] } };
      },
    });

    const all = output.join("\n");
    expect(all).toContain("volt");
    expect(all).toContain("neo");
    expect(all).toContain("clinic-nat");
    expect(all).toContain("unreachable");
    expect(all).toContain("timeout");
  });

  test("--node white filter: only white agents shown", async () => {
    const peers = ["http://white:3456"];
    await cmdFederationAgents({ node: "white" }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      nodeName: () => "m5",
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "mother", session: "14-mother", window: "mother-oracle", state: "idle" }] },
        },
      }),
    });

    const all = output.join("\n");
    expect(all).toContain("mother");
    expect(all).not.toContain("volt"); // local agent filtered out (node = "m5")
    expect(all).not.toContain("m5 (local)");
  });

  test("--oracle '*volt*' glob filter", async () => {
    const peers = ["http://white:3456"];
    await cmdFederationAgents({ oracle: "*volt*" }, {
      getLocalAgents: makeLocalAgents("m5", [
        localAgent,
        { oracle: "volt-oracle", session: "37-volt-oracle", window: "volt-oracle-oracle", state: "idle" },
        { oracle: "pigment", session: "04-pigment", window: "pigment-oracle", state: "active" },
      ]),
      peers: () => peers,
      namedPeers: () => [],
      nodeName: () => "m5",
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "volt-prod", session: "99-volt", window: "volt-prod-oracle", state: "active" }] },
        },
      }),
    });

    const all = output.join("\n");
    expect(all).toContain("volt");
    expect(all).toContain("volt-oracle");
    expect(all).toContain("volt-prod");
    expect(all).not.toContain("pigment");
  });

  test("--json shape contract", async () => {
    const peers = ["http://white:3456"];
    await cmdFederationAgents({ json: true }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      nodeName: () => "m5",
      fetch: makeFetch({
        "http://white:3456/api/agents": {
          ok: true, status: 200,
          data: { agents: [{ node: "white", oracle: "mother", session: "14-mother", window: "mother-oracle", state: "idle" }] },
        },
      }),
    });

    const raw = output.join("\n");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("agents");
    expect(parsed).toHaveProperty("skipped");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    expect(parsed.agents.length).toBe(2);
    expect(parsed.skipped.length).toBe(0);

    const volt = parsed.agents.find((a: FederationAgent) => a.oracle === "volt");
    expect(volt).toBeDefined();
    expect(volt.node).toBe("m5");
    expect(volt.session).toBe("36-volt");
    expect(volt.state).toBe("active");
  });

  test("empty fleet: no agents anywhere", async () => {
    await cmdFederationAgents({ json: false }, {
      getLocalAgents: makeLocalAgents("m5", []),
      peers: () => [],
      namedPeers: () => [],
      nodeName: () => "m5",
      fetch: makeFetch({}),
    });

    const all = output.join("\n");
    expect(all).toContain("no agents found");
  });

  test("all peers fail: skipped list shows all, no crash", async () => {
    const peers = ["http://alpha:3456", "http://bravo:3456"];
    await cmdFederationAgents({ json: false }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [],
      nodeName: () => "m5",
      fetch: async () => { throw new Error("connection refused"); },
    });

    const all = output.join("\n");
    expect(all).toContain("volt"); // local still renders
    expect(output.filter(l => l.includes("unreachable")).length).toBe(2);
  });

  test("peer returns non-ok status: recorded as skipped", async () => {
    const peers = ["http://white:3456"];
    await cmdFederationAgents({ json: false }, {
      getLocalAgents: makeLocalAgents("m5", [localAgent]),
      peers: () => peers,
      namedPeers: () => [{ name: "white", url: "http://white:3456" }],
      nodeName: () => "m5",
      fetch: makeFetch({ "http://white:3456/api/agents": { ok: false, status: 503, data: null } }),
    });

    const all = output.join("\n");
    expect(all).toContain("white");
    expect(all).toContain("unreachable");
    expect(all).toContain("HTTP 503");
  });
});
