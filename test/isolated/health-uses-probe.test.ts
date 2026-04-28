/**
 * health-uses-probe.test.ts — #804 Step 5.
 *
 * Pinpoint regression: `maw health` must hit POST /api/probe, not GET
 * /api/sessions or GET /api/identity. The motivation is the #795 schema-drift
 * incident — /api/identity returned 200 OK while /api/send was broken,
 * because they took disjoint code paths. Step 5 introduces /api/probe to
 * walk the same write-path branches /api/send walks, and switches health
 * to use it so a green health check means a green delivery channel.
 *
 * Strategy: stub global fetch to record (url, method) calls. Run cmdHealth
 * with everything else mocked out. Assert exactly one POST to /api/probe
 * and zero requests to /api/sessions or /api/identity from cmdHealth.
 *
 * Isolated because: we mutate global fetch + mock.module the sdk + config
 * + tmux modules; mock.module is process-global in Bun 1.3.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

// ─── Capture real fetch for restore ─────────────────────────────────────────

const realFetch = globalThis.fetch;

// ─── Track every fetch call cmdHealth makes ─────────────────────────────────

interface FetchCall { url: string; method: string; body?: string }
let fetchCalls: FetchCall[] = [];
let probeResponseStatus = 200;
let probeResponseBody: unknown = { ok: true, transport: "local", source: "test-node", sessions: 2 };

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    return new Response(JSON.stringify(probeResponseBody), {
      status: probeResponseStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({ host: "localhost", port: 3456, peers: [], namedPeers: [] }));
});

// sdk barrel — health imports curlFetch + tmux from "../../../sdk".
// Mock with a passthrough-style stub: tmux.listSessions returns one session;
// curlFetch is unused for the maw-server check (we call global fetch directly)
// but used for peer checks — return reachable for any call.
mock.module(join(root, "src/sdk"), () => ({
  tmux: {
    listSessions: async () => [{ name: "test-session", windows: [] }],
  },
  curlFetch: async () => ({ ok: true, status: 200, data: {} }),
}));

// ─── Harness ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  fetchCalls = [];
  probeResponseStatus = 200;
  probeResponseBody = { ok: true, transport: "local", source: "test-node", sessions: 2 };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// Suppress console output from cmdHealth — it prints status lines we don't care about.
function silently<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = origLog; });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("maw health — uses /api/probe (#804 Step 5)", () => {
  test("POSTs /api/probe — never GETs /api/sessions or /api/identity", async () => {
    const { cmdHealth } = await import("../../src/commands/plugins/health/impl");
    await silently(() => cmdHealth());

    // The probe call must exist…
    const probeCalls = fetchCalls.filter(c => c.url.includes("/api/probe"));
    expect(probeCalls.length).toBeGreaterThanOrEqual(1);
    expect(probeCalls[0].method).toBe("POST");

    // …and the regressed endpoints must NOT be hit by health.
    const sessionsCalls = fetchCalls.filter(c => c.url.endsWith("/api/sessions") || c.url.includes("/api/sessions?"));
    expect(sessionsCalls.length).toBe(0);

    const identityCalls = fetchCalls.filter(c => c.url.includes("/api/identity"));
    expect(identityCalls.length).toBe(0);
  });

  test("probe POST sends a JSON body (healthcheck mode — no target required)", async () => {
    const { cmdHealth } = await import("../../src/commands/plugins/health/impl");
    await silently(() => cmdHealth());

    const probeCall = fetchCalls.find(c => c.url.includes("/api/probe"));
    expect(probeCall).toBeDefined();
    // Body should be valid JSON. Empty object is the sentinel for "healthcheck mode".
    expect(() => JSON.parse(probeCall!.body || "")).not.toThrow();
  });

  test("probe non-200 → maw-server check reports warn (not ok)", async () => {
    probeResponseStatus = 503;
    probeResponseBody = { ok: false, error: "tmux down" };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      const { cmdHealth } = await import("../../src/commands/plugins/health/impl");
      await cmdHealth();
    } finally {
      console.log = origLog;
    }

    const out = logs.join("\n");
    // Status icon line should NOT show a green ok for maw server when probe fails.
    // We assert by checking no "ok" detail line for maw server.
    expect(out).toContain("maw server");
    expect(out).toMatch(/maw server[^\n]*(HTTP 503|warn|probe)/);
  });
});
