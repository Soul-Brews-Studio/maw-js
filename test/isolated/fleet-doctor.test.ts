/**
 * fleet-doctor.ts + fleet-doctor-stale-peers.ts — orchestrator + async peer check.
 *
 * Two targets, one test file because they share transitive mocks (src/sdk,
 * src/config) and cmdFleetDoctor calls checkStalePeers through the same
 * curlFetch seam.
 *
 * checkStalePeers: parallel GET /api/identity per peer, classifying each as
 *   - finding + no identity (unreachable / bad shape / thrown)
 *   - identity only (valid shape → {node, agents[]}), strings-only filter
 * cmdFleetDoctor: loads config + fleet + tmux sessions, runs the 7 checks,
 *   renders grouped output (or JSON), optionally autoFix, then process.exit.
 *
 * Isolated because we mock.module on three seams:
 *   - src/sdk                               (curlFetch, listSessions)
 *   - src/config                            (loadConfig — cmdFleetDoctor entry)
 *   - src/commands/shared/fleet-load        (loadFleetEntries)
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 *
 * process.exit is stubbed into a throw so the harness observes the
 * many exit branches of cmdFleetDoctor (healthy / warnings / errors / json).
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rSdk = await import("../../src/sdk");
const realCurlFetch = _rSdk.curlFetch;
const realListSessions = _rSdk.listSessions;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

const _rFleetLoad = await import("../../src/commands/shared/fleet-load");
const realLoadFleetEntries = _rFleetLoad.loadFleetEntries;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

interface CurlResponse { ok: boolean; status?: number; data?: unknown; }
interface CurlFetchCall { url: string; opts: unknown; }

let curlFetchCalls: CurlFetchCall[] = [];
let curlFetchResponses: Array<{ match: RegExp; response?: CurlResponse; error?: string }> = [];

interface PaneSession { name: string; windows: Array<{ index: number; name: string; active: boolean }>; }
let listSessionsReturn: PaneSession[] = [];
let listSessionsThrows = false;

let configOverride: Record<string, unknown> = {};
let loadFleetEntriesReturn: Array<{ session: { name: string; windows: Array<{ repo?: string }> } }> = [];
let loadFleetEntriesThrows = false;

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    curlFetch: async (...args: unknown[]) => {
      if (!mockActive) return (realCurlFetch as (...a: unknown[]) => unknown)(...args);
      const [url, opts] = args as [string, unknown];
      curlFetchCalls.push({ url, opts });
      for (const r of curlFetchResponses) {
        if (r.match.test(url)) {
          if (r.error) throw new Error(r.error);
          return r.response!;
        }
      }
      return { ok: false, status: 0, data: null };
    },
    listSessions: async (...args: unknown[]) => {
      if (!mockActive) return (realListSessions as (...a: unknown[]) => Promise<PaneSession[]>)(...args);
      if (listSessionsThrows) throw new Error("tmux refused");
      return listSessionsReturn;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: unknown[]) =>
      mockActive ? configOverride : (realLoadConfig as (...a: unknown[]) => unknown)(...args),
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/shared/fleet-load"),
  () => ({
    ..._rFleetLoad,
    loadFleetEntries: (...args: unknown[]) => {
      if (!mockActive) return (realLoadFleetEntries as (...a: unknown[]) => unknown)(...args);
      if (loadFleetEntriesThrows) throw new Error("fleet dir missing");
      return loadFleetEntriesReturn;
    },
  }),
);

// NB: import targets AFTER mocks so their import graph resolves through our stubs.
const { checkStalePeers } = await import("../../src/commands/shared/fleet-doctor-stale-peers");
const { cmdFleetDoctor } = await import("../../src/commands/shared/fleet-doctor");

// ─── Harness for cmdFleetDoctor (stdout + process.exit capture) ─────────────

const origLog = console.log;
const origExit = process.exit;

let outs: string[] = [];
let exitCode: number | undefined;

async function run(fn: () => Promise<unknown>): Promise<void> {
  outs = []; exitCode = undefined;
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  curlFetchCalls = [];
  curlFetchResponses = [];
  listSessionsReturn = [];
  listSessionsThrows = false;
  configOverride = {};
  loadFleetEntriesReturn = [];
  loadFleetEntriesThrows = false;
});

afterEach(() => { mockActive = false; });
afterAll(() => {
  mockActive = false;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

// ════════════════════════════════════════════════════════════════════════════
// checkStalePeers — async network check
// ════════════════════════════════════════════════════════════════════════════

describe("checkStalePeers — reachable happy path", () => {
  test("valid identity → no finding, identities map populated", async () => {
    curlFetchResponses = [{
      match: /white\.example\/api\/identity$/,
      response: { ok: true, status: 200, data: { node: "white", agents: ["neo", "mawjs"] } },
    }];

    const out = await checkStalePeers([{ name: "white", url: "https://white.example" }]);

    expect(out.findings).toEqual([]);
    expect(out.identities).toEqual({
      white: { node: "white", agents: ["neo", "mawjs"] },
    });
  });

  test("URL built as `${peer.url}/api/identity` verbatim (no normalization)", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "w", agents: [] } },
    }];

    await checkStalePeers([{ name: "white", url: "https://white.example" }]);

    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("https://white.example/api/identity");
  });

  test("non-string agents entries silently filtered, identity stored with strings only", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: {
        ok: true,
        status: 200,
        data: { node: "mba", agents: ["neo", 42, null, "mawjs", { bogus: true }, "white"] },
      },
    }];

    const out = await checkStalePeers([{ name: "mba", url: "https://mba.example" }]);

    expect(out.findings).toEqual([]);
    expect(out.identities.mba).toEqual({ node: "mba", agents: ["neo", "mawjs", "white"] });
  });

  test("empty agents array → identity stored with empty agent list", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "fresh", agents: [] } },
    }];

    const out = await checkStalePeers([{ name: "fresh", url: "https://fresh.example" }]);

    expect(out.findings).toEqual([]);
    expect(out.identities).toEqual({ fresh: { node: "fresh", agents: [] } });
  });

  test("explicit timeout forwarded to curlFetch", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "x", agents: [] } },
    }];

    await checkStalePeers([{ name: "x", url: "https://x.example" }], 7777);

    expect(curlFetchCalls[0].opts).toEqual({ timeout: 7777 });
  });

  test("default timeout=3000 when omitted", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "x", agents: [] } },
    }];

    await checkStalePeers([{ name: "x", url: "https://x.example" }]);

    expect(curlFetchCalls[0].opts).toEqual({ timeout: 3000 });
  });
});

describe("checkStalePeers — unreachable branches", () => {
  test("res.ok=false → warn finding + NO identity entry", async () => {
    curlFetchResponses = [{
      match: /down\.example/,
      response: { ok: false, status: 500, data: null },
    }];

    const out = await checkStalePeers([{ name: "down", url: "https://down.example" }]);

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].level).toBe("warn");
    expect(out.findings[0].check).toBe("stale-peer");
    expect(out.findings[0].fixable).toBe(false);
    expect(out.findings[0].message).toContain("did not respond");
    expect(out.findings[0].message).toContain("down");
    expect(out.findings[0].message).toContain("https://down.example");
    expect(out.identities).toEqual({});
  });

  test("res.ok=true but data null → warn finding (treated as no-response)", async () => {
    curlFetchResponses = [{
      match: /empty\.example/,
      response: { ok: true, status: 200, data: null },
    }];

    const out = await checkStalePeers([{ name: "empty", url: "https://empty.example" }]);

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].message).toContain("did not respond");
    expect(out.identities).toEqual({});
  });

  test("curlFetch throws → separate 'unreachable' warn finding", async () => {
    curlFetchResponses = [{ match: /boom/, error: "ECONNREFUSED" }];

    const out = await checkStalePeers([{ name: "boom", url: "https://boom.example" }]);

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].level).toBe("warn");
    expect(out.findings[0].check).toBe("stale-peer");
    expect(out.findings[0].message).toContain("unreachable");
    expect(out.findings[0].message).toContain("boom");
    expect(out.identities).toEqual({});
  });

  test("invalid identity shape (node not string) → reachable & ok, but identity NOT recorded", async () => {
    // Contract quirk: the branch passes ok:true validation, stores nothing,
    // and emits no finding — this is intentional (invalid shape silently
    // ignored; the missing-agent downstream check handles the consequences).
    curlFetchResponses = [{
      match: /weird/,
      response: { ok: true, status: 200, data: { node: 42, agents: [] } },
    }];

    const out = await checkStalePeers([{ name: "weird", url: "https://weird.example" }]);

    expect(out.findings).toEqual([]);
    expect(out.identities).toEqual({});
  });

  test("invalid identity shape (agents not array) → no finding, no identity", async () => {
    curlFetchResponses = [{
      match: /weird/,
      response: { ok: true, status: 200, data: { node: "x", agents: "nope" } },
    }];

    const out = await checkStalePeers([{ name: "weird", url: "https://weird.example" }]);

    expect(out.findings).toEqual([]);
    expect(out.identities).toEqual({});
  });
});

describe("checkStalePeers — parallelism", () => {
  test("multiple peers issued in parallel; findings + identities merged", async () => {
    curlFetchResponses = [
      { match: /white\.example/, response: { ok: true, status: 200, data: { node: "white", agents: ["neo"] } } },
      { match: /mba\.example/,   response: { ok: false, status: 502, data: null } },
      { match: /boom\.example/,  error: "connect ETIMEDOUT" },
    ];

    const out = await checkStalePeers([
      { name: "white", url: "https://white.example" },
      { name: "mba",   url: "https://mba.example" },
      { name: "boom",  url: "https://boom.example" },
    ]);

    expect(curlFetchCalls).toHaveLength(3);
    expect(out.identities).toEqual({ white: { node: "white", agents: ["neo"] } });
    expect(out.findings).toHaveLength(2);
    const msgs = out.findings.map((f) => f.message).join("\n");
    expect(msgs).toContain("did not respond");
    expect(msgs).toContain("unreachable");
  });

  test("empty peers list → no calls, no findings, no identities", async () => {
    const out = await checkStalePeers([]);

    expect(curlFetchCalls).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.identities).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════
// cmdFleetDoctor — orchestrator
// ════════════════════════════════════════════════════════════════════════════

describe("cmdFleetDoctor — healthy config path", () => {
  test("no peers, no agents, no fleet → exit 0 with 'healthy' message", async () => {
    configOverride = { node: "local", namedPeers: [], agents: {}, port: 3456, ghqRoot: "/tmp/nope" };
    loadFleetEntriesReturn = [];
    listSessionsReturn = [];

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(0);
    const joined = outs.join("\n");
    expect(joined).toContain("Fleet Doctor");
    expect(joined).toContain("No issues found");
  });

  test("header reports node name + peer/agent/session counts", async () => {
    configOverride = {
      node: "white",
      namedPeers: [{ name: "mba", url: "https://mba.example" }],
      agents: { neo: "white", mawjs: "mba" },
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { node: "mba", agents: ["mawjs"] } },
    }];
    listSessionsReturn = [
      { name: "05-neo", windows: [{ index: 0, name: "neo-oracle", active: true }] },
    ];

    await run(() => cmdFleetDoctor());

    const joined = outs.join("\n");
    expect(joined).toContain("node: white");
    expect(joined).toContain("1 peers");
    expect(joined).toContain("2 agents");
    expect(joined).toContain("1 sessions");
  });
});

describe("cmdFleetDoctor — failure exit codes", () => {
  test("errors present → exit 2", async () => {
    // Orphan route produces an error-level finding.
    configOverride = {
      node: "white",
      namedPeers: [],
      agents: { ghost: "unknown-node" },
      port: 3456,
      ghqRoot: "/tmp/nope",
    };

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(2);
    expect(outs.join("\n")).toContain("orphan-route");
  });

  test("warnings (no errors) → exit 1", async () => {
    // Self-peer (warn-level) with no errors.
    configOverride = {
      node: "white",
      namedPeers: [{ name: "white", url: "https://white.example" }],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{
      match: /white\.example/,
      response: { ok: true, status: 200, data: { node: "white", agents: [] } },
    }];

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(1);
    expect(outs.join("\n")).toContain("self-peer");
  });

  test("findings grouped by check with count badge", async () => {
    configOverride = {
      node: "white",
      namedPeers: [
        { name: "dup", url: "https://a.example" },
        { name: "dup", url: "https://b.example" },
      ],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [
      { match: /a\.example/, response: { ok: true, status: 200, data: { node: "a", agents: [] } } },
      { match: /b\.example/, response: { ok: true, status: 200, data: { node: "b", agents: [] } } },
    ];

    await run(() => cmdFleetDoctor());

    const joined = outs.join("\n");
    expect(joined).toContain("duplicate-peer");
    // Count badge renders "(N)" next to the check name
    expect(joined).toMatch(/duplicate-peer.*\(1\)/);
  });

  test("fixable findings → 'Rerun with --fix' hint shown", async () => {
    // Missing-agent is fixable=true.
    configOverride = {
      node: "white",
      namedPeers: [{ name: "mba", url: "https://mba.example" }],
      agents: {}, // mawjs missing
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { node: "mba", agents: ["mawjs"] } },
    }];

    await run(() => cmdFleetDoctor());

    expect(outs.join("\n")).toContain("Rerun with --fix");
  });
});

describe("cmdFleetDoctor — autofix path", () => {
  test("opts.fix=true with fixable finding → applies and prints applied-list", async () => {
    configOverride = {
      node: "white",
      namedPeers: [{ name: "mba", url: "https://mba.example" }],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
      save: () => {/* no-op — autoFix defaults to defaultSave which lazy-requires config */ },
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { node: "mba", agents: ["mawjs"] } },
    }];

    await run(() => cmdFleetDoctor({ fix: true }));

    const joined = outs.join("\n");
    expect(joined).toContain("Applied");
    expect(joined).toContain("config.agents['mawjs']");
  });

  test("opts.fix=true with no fixable findings → prints 'need a human' hint", async () => {
    // Orphan-route finding is NOT fixable.
    configOverride = {
      node: "white",
      namedPeers: [],
      agents: { ghost: "unknown" },
      port: 3456,
      ghqRoot: "/tmp/nope",
    };

    await run(() => cmdFleetDoctor({ fix: true }));

    expect(outs.join("\n")).toContain("need a human");
  });
});

describe("cmdFleetDoctor — json output", () => {
  test("opts.json=true + healthy → emits {node, findings:[]} and exit 0", async () => {
    configOverride = {
      node: "white",
      namedPeers: [],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };

    await run(() => cmdFleetDoctor({ json: true }));

    expect(exitCode).toBe(0);
    // Find the line that's parseable JSON.
    const jsonLine = outs.find((l) => l.trim().startsWith("{"))!;
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(outs.join("\n"));
    expect(parsed.node).toBe("white");
    expect(parsed.findings).toEqual([]);
  });

  test("opts.json=true + warnings → exit 1 with findings array populated", async () => {
    configOverride = {
      node: "white",
      namedPeers: [{ name: "white", url: "https://white.example" }], // self-peer warn
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{
      match: /white\.example/,
      response: { ok: true, status: 200, data: { node: "white", agents: [] } },
    }];

    await run(() => cmdFleetDoctor({ json: true }));

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(outs.join("\n"));
    expect(parsed.node).toBe("white");
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.findings[0].check).toBe("self-peer");
  });

  test("opts.json=true + errors → exit 2", async () => {
    configOverride = {
      node: "white",
      namedPeers: [],
      agents: { ghost: "unknown-node" }, // orphan-route error
      port: 3456,
      ghqRoot: "/tmp/nope",
    };

    await run(() => cmdFleetDoctor({ json: true }));

    expect(exitCode).toBe(2);
  });
});

describe("cmdFleetDoctor — graceful degradation", () => {
  test("loadFleetEntries throws (fresh node, no fleet dir) → doesn't crash", async () => {
    configOverride = {
      node: "fresh",
      namedPeers: [],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    loadFleetEntriesThrows = true;

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("No issues found");
  });

  test("listSessions throws (no tmux server) → doesn't crash, 0 sessions in header", async () => {
    configOverride = {
      node: "fresh",
      namedPeers: [],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    listSessionsThrows = true;

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("0 sessions");
  });

  test("loadConfig returning undefined node → defaults to 'local' in header", async () => {
    configOverride = { namedPeers: [], agents: {}, port: 3456, ghqRoot: "/tmp/nope" };

    await run(() => cmdFleetDoctor());

    expect(outs.join("\n")).toContain("node: local");
  });

  test("missing ghqRoot entries → info-level missing-repo finding, exit 0 (warn/error absent)", async () => {
    configOverride = {
      node: "white",
      namedPeers: [],
      agents: {},
      port: 3456,
      ghqRoot: "/definitely/not/a/real/path",
    };
    loadFleetEntriesReturn = [
      { session: { name: "01-ghost", windows: [{ repo: "org/ghost" }] } },
    ];

    await run(() => cmdFleetDoctor());

    // info-level only → exit 0 per (errors>0?2:warnings>0?1:0) ladder.
    expect(exitCode).toBe(0);
    expect(outs.join("\n")).toContain("missing-repo");
  });
});

describe("cmdFleetDoctor — stale peer + missing-agent integration", () => {
  test("unreachable peer → stale-peer finding surfaces in grouped output", async () => {
    configOverride = {
      node: "white",
      namedPeers: [{ name: "dead", url: "https://dead.example" }],
      agents: {},
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{ match: /dead\.example/, error: "ENETUNREACH" }];

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(1); // warn-level
    const joined = outs.join("\n");
    expect(joined).toContain("stale-peer");
    expect(joined).toContain("dead");
  });

  test("peer identity surfaces missing-agent finding downstream", async () => {
    configOverride = {
      node: "white",
      namedPeers: [{ name: "mba", url: "https://mba.example" }],
      agents: { neo: "white" }, // 'mawjs' on mba is missing locally
      port: 3456,
      ghqRoot: "/tmp/nope",
    };
    curlFetchResponses = [{
      match: /mba\.example/,
      response: { ok: true, status: 200, data: { node: "mba", agents: ["mawjs"] } },
    }];

    await run(() => cmdFleetDoctor());

    expect(exitCode).toBe(1);
    expect(outs.join("\n")).toContain("missing-agent");
  });
});
