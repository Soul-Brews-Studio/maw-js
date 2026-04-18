/**
 * workspace-lifecycle.ts — cmdWorkspaceCreate / cmdWorkspaceJoin / cmdWorkspaceLeave
 * workspace-agents.ts   — cmdWorkspaceShare / cmdWorkspaceUnshare / cmdWorkspaceAgents
 * workspace-query.ts    — cmdWorkspaceLs / cmdWorkspaceInvite / cmdWorkspaceStatus
 *
 * All three share workspace-store (real fs under a tempdir). The seams we mock:
 *   - src/sdk     → curlFetch (stubbed; passthrough otherwise)
 *   - src/config  → loadConfig (stubbed; cfgTimeout falls through to defaults)
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so the
 * passthrough branch doesn't point at our wrapper (see #375 pollution catalog).
 * Every passthrough wrapper forwards via (...args).
 * os.homedir() caching is avoided by setting process.env.MAW_CONFIG_DIR to a
 * mkdtempSync path BEFORE any workspace-* module is imported — workspace-store
 * reads that env var at module load (src/commands/shared/workspace-store.ts:7).
 *
 * process.exit is stubbed into a throw so we can observe exit branches without
 * tearing the runner down.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Set up tempdir HOME for workspace-store BEFORE importing anything ──────

const tmpConfigDir = mkdtempSync(join(tmpdir(), "maw-workspace-test-"));
process.env.MAW_CONFIG_DIR = tmpConfigDir;
const WS_DIR = join(tmpConfigDir, "workspaces");

function clearWorkspacesDir(): void {
  try {
    for (const f of readdirSync(WS_DIR)) {
      try { rmSync(join(WS_DIR, f), { force: true }); } catch {}
    }
  } catch {}
}

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rSdk = await import("../../src/sdk");
const realCurlFetch = _rSdk.curlFetch;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

interface CurlResponse { ok: boolean; status?: number; data?: unknown; }
interface CurlStub { match: RegExp; response?: CurlResponse; error?: string; }

let curlStubs: CurlStub[] = [];
let curlCalls: Array<{ url: string; opts: unknown }> = [];

let configOverride: Record<string, unknown> = {};

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    curlFetch: async (...args: unknown[]) => {
      if (!mockActive) return (realCurlFetch as (...a: unknown[]) => unknown)(...args);
      const [url, opts] = args as [string, unknown];
      curlCalls.push({ url, opts });
      for (const s of curlStubs) {
        if (s.match.test(url)) {
          if (s.error) throw new Error(s.error);
          return s.response!;
        }
      }
      return { ok: false, status: 0, data: null };
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

// Import targets AFTER mocks so their import graph resolves through our stubs.
const {
  cmdWorkspaceCreate, cmdWorkspaceJoin, cmdWorkspaceLeave,
} = await import("../../src/commands/shared/workspace-lifecycle");
const {
  cmdWorkspaceShare, cmdWorkspaceUnshare, cmdWorkspaceAgents,
} = await import("../../src/commands/shared/workspace-agents");
const {
  cmdWorkspaceLs, cmdWorkspaceInvite, cmdWorkspaceStatus,
} = await import("../../src/commands/shared/workspace-query");

// ─── Harness (stdout + stderr + process.exit capture) ───────────────────────

const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

let outs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

async function run(fn: () => Promise<unknown>): Promise<void> {
  outs = []; errs = []; exitCode = undefined;
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.log = origLog; console.error = origErr;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

function writeWsFile(id: string, ws: Record<string, unknown>): void {
  writeFileSync(join(WS_DIR, `${id}.json`), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  mockActive = true;
  curlStubs = [];
  curlCalls = [];
  configOverride = {};
  clearWorkspacesDir();
});

afterEach(() => {
  mockActive = false;
});

afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origErr;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
  try { rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-lifecycle.ts — cmdWorkspaceCreate
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceCreate", () => {
  test("no hub available → error + exit 1", async () => {
    configOverride = {};
    await run(() => cmdWorkspaceCreate("alpha"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no hub URL");
  });

  test("explicit hub + ok response → writes ws config to disk", async () => {
    curlStubs = [{
      match: /^https?:\/\/example\.com\/api\/workspace\/create(?:\?|$)/,
      response: { ok: true, status: 200, data: { id: "ws-1", name: "alpha", joinCode: "abc123" } },
    }];
    configOverride = { node: "white" };

    await run(() => cmdWorkspaceCreate("alpha", "https://example.com"));

    expect(exitCode).toBeUndefined();
    expect(curlCalls).toHaveLength(1);
    expect(curlCalls[0].url).toBe("https://example.com/api/workspace/create");
    expect((curlCalls[0].opts as { method: string }).method).toBe("POST");
    const body = JSON.parse((curlCalls[0].opts as { body: string }).body);
    expect(body).toEqual({ name: "alpha", nodeId: "white" });

    const p = join(WS_DIR, "ws-1.json");
    expect(existsSync(p)).toBe(true);
    const saved = JSON.parse(readFileSync(p, "utf-8"));
    expect(saved).toMatchObject({
      id: "ws-1", name: "alpha", hubUrl: "https://example.com",
      joinCode: "abc123", sharedAgents: [], lastStatus: "connected",
    });
    expect(typeof saved.joinedAt).toBe("string");

    const joined = outs.join("\n");
    expect(joined).toContain("workspace created");
    expect(joined).toContain("ws-1");
    expect(joined).toContain("Join code:");
    expect(joined).toContain("abc123");
  });

  test("config.node absent → nodeId defaults to 'local'", async () => {
    curlStubs = [{
      match: /api\/workspace\/create/,
      response: { ok: true, data: { id: "ws-2", name: "beta" } },
    }];
    configOverride = {};

    await run(() => cmdWorkspaceCreate("beta", "https://h.example"));

    const body = JSON.parse((curlCalls[0].opts as { body: string }).body);
    expect(body.nodeId).toBe("local");
  });

  test("server omits joinCode → 'Join code:' line not printed", async () => {
    curlStubs = [{
      match: /create/,
      response: { ok: true, data: { id: "ws-3", name: "gamma" } },
    }];

    await run(() => cmdWorkspaceCreate("gamma", "https://h.example"));

    expect(outs.some(o => o.includes("Join code:"))).toBe(false);
  });

  test("server responds ok but without data.id → exit 1", async () => {
    curlStubs = [{
      match: /create/,
      response: { ok: true, status: 200, data: { error: "boom" } },
    }];

    await run(() => cmdWorkspaceCreate("delta", "https://h.example"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("failed to create workspace");
    expect(errs.join("\n")).toContain("boom");
  });

  test("server HTTP failure with no data → surfaces HTTP status", async () => {
    curlStubs = [{
      match: /create/,
      response: { ok: false, status: 503, data: null },
    }];

    await run(() => cmdWorkspaceCreate("eps", "https://h.example"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("HTTP 503");
  });

  test("server omits name in response → falls back to arg name", async () => {
    curlStubs = [{
      match: /create/,
      response: { ok: true, data: { id: "ws-4" } },
    }];

    await run(() => cmdWorkspaceCreate("zeta", "https://h.example"));

    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-4.json"), "utf-8"));
    expect(saved.name).toBe("zeta");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-lifecycle.ts — cmdWorkspaceJoin
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceJoin", () => {
  test("no hub → exit 1", async () => {
    configOverride = {};
    await run(() => cmdWorkspaceJoin("code-xyz"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no hub URL");
  });

  test("ok response with agents as objects → renders name from each", async () => {
    curlStubs = [{
      match: /api\/workspace\/join/,
      response: {
        ok: true,
        data: {
          id: "ws-j1", name: "joined-ws",
          agents: [{ name: "alice" }, { name: "bob" }],
        },
      },
    }];
    configOverride = { node: "mba" };

    await run(() => cmdWorkspaceJoin("inv-123", "https://hub.example"));

    expect(exitCode).toBeUndefined();
    const body = JSON.parse((curlCalls[0].opts as { body: string }).body);
    expect(body).toEqual({ code: "inv-123", node: "mba" });

    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-j1.json"), "utf-8"));
    expect(saved).toMatchObject({
      id: "ws-j1", name: "joined-ws", hubUrl: "https://hub.example",
      joinCode: "inv-123", sharedAgents: [], lastStatus: "connected",
    });

    const joined = outs.join("\n");
    expect(joined).toContain("joined workspace");
    expect(joined).toContain("2 available");
    expect(joined).toContain("alice");
    expect(joined).toContain("bob");
  });

  test("agents as bare strings also render", async () => {
    curlStubs = [{
      match: /join/,
      response: { ok: true, data: { id: "ws-j2", name: "n", agents: ["carol", "dan"] } },
    }];

    await run(() => cmdWorkspaceJoin("c", "https://h.example"));

    const joined = outs.join("\n");
    expect(joined).toContain("carol");
    expect(joined).toContain("dan");
  });

  test("empty agents list → no 'X available' line", async () => {
    curlStubs = [{
      match: /join/,
      response: { ok: true, data: { id: "ws-j3", name: "n", agents: [] } },
    }];

    await run(() => cmdWorkspaceJoin("c", "https://h.example"));

    expect(outs.some(o => o.includes("available"))).toBe(false);
  });

  test("server omits name → falls back to 'unknown'", async () => {
    curlStubs = [{
      match: /join/,
      response: { ok: true, data: { id: "ws-j4" } },
    }];

    await run(() => cmdWorkspaceJoin("c", "https://h.example"));

    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-j4.json"), "utf-8"));
    expect(saved.name).toBe("unknown");
  });

  test("response lacks data.id → exit 1 with error", async () => {
    curlStubs = [{
      match: /join/,
      response: { ok: true, data: { error: "bad code" } },
    }];

    await run(() => cmdWorkspaceJoin("c", "https://h.example"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("failed to join workspace");
    expect(errs.join("\n")).toContain("bad code");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-lifecycle.ts — cmdWorkspaceLeave
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceLeave", () => {
  test("no workspace joined → reportNoWorkspaceId + exit 1", async () => {
    await run(() => cmdWorkspaceLeave());
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no workspaces joined");
  });

  test("explicit id that doesn't exist → 'workspace not found' + exit 1", async () => {
    await run(() => cmdWorkspaceLeave("ghost"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("workspace not found: ghost");
  });

  test("multiple workspaces + no explicit id → multi hint + exit 1", async () => {
    writeWsFile("a", { id: "a", name: "A", hubUrl: "https://a.example", sharedAgents: [], joinedAt: "t" });
    writeWsFile("b", { id: "b", name: "B", hubUrl: "https://b.example", sharedAgents: [], joinedAt: "t" });

    await run(() => cmdWorkspaceLeave());

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain("multiple workspaces joined");
    expect(joined).toContain("pass one with --workspace");
  });

  test("happy path: hub ok → local file renamed with .left suffix", async () => {
    writeWsFile("w-leave", { id: "w-leave", name: "leaveme", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /leave/, response: { ok: true, data: null } }];

    await run(() => cmdWorkspaceLeave("w-leave"));

    expect(exitCode).toBeUndefined();
    expect(existsSync(join(WS_DIR, "w-leave.json"))).toBe(false);
    expect(existsSync(join(WS_DIR, "w-leave.left.json"))).toBe(true);
    expect(outs.join("\n")).toContain("left workspace");
    expect(outs.join("\n")).toContain("leaveme");
  });

  test("hub returns non-ok → still removes local config, prints warning", async () => {
    writeWsFile("w-stuck", { id: "w-stuck", name: "stuck", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /leave/, response: { ok: false, status: 500, data: { error: "hub err" } } }];

    await run(() => cmdWorkspaceLeave("w-stuck"));

    expect(errs.join("\n")).toContain("failed to leave workspace");
    expect(outs.join("\n")).toContain("removing local config anyway");
    expect(existsSync(join(WS_DIR, "w-stuck.json"))).toBe(false);
    expect(existsSync(join(WS_DIR, "w-stuck.left.json"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-agents.ts — cmdWorkspaceShare
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceShare", () => {
  test("no workspace → exit 1", async () => {
    await run(() => cmdWorkspaceShare(["alice"]));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no workspaces joined");
  });

  test("workspace id not found → exit 1", async () => {
    await run(() => cmdWorkspaceShare(["alice"], "ghost"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("workspace not found: ghost");
  });

  test("happy path: dedupes + updates local sharedAgents", async () => {
    writeWsFile("ws-s", {
      id: "ws-s", name: "s", hubUrl: "https://h.example",
      sharedAgents: ["alice"], joinedAt: "t",
    });
    curlStubs = [{ match: /agents/, response: { ok: true, data: null } }];

    await run(() => cmdWorkspaceShare(["alice", "bob"], "ws-s"));

    expect(exitCode).toBeUndefined();
    const body = JSON.parse((curlCalls[0].opts as { body: string }).body);
    expect(body).toEqual({ action: "share", agents: ["alice", "bob"], node: "local" });

    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-s.json"), "utf-8"));
    // alice deduped, bob added
    expect(saved.sharedAgents.sort()).toEqual(["alice", "bob"]);
    expect(outs.join("\n")).toContain("shared 2 agent(s)");
    expect(outs.join("\n")).toContain("total shared: 2");
  });

  test("hub failure → exit 1, local sharedAgents unchanged", async () => {
    writeWsFile("ws-sf", {
      id: "ws-sf", name: "sf", hubUrl: "https://h.example",
      sharedAgents: ["eve"], joinedAt: "t",
    });
    curlStubs = [{ match: /agents/, response: { ok: false, status: 502, data: null } }];

    await run(() => cmdWorkspaceShare(["frank"], "ws-sf"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("failed to share agents");
    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-sf.json"), "utf-8"));
    expect(saved.sharedAgents).toEqual(["eve"]); // unchanged
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-agents.ts — cmdWorkspaceUnshare
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceUnshare", () => {
  test("no workspace → exit 1", async () => {
    await run(() => cmdWorkspaceUnshare(["a"]));
    expect(exitCode).toBe(1);
  });

  test("workspace not found → exit 1", async () => {
    await run(() => cmdWorkspaceUnshare(["a"], "ghost"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("workspace not found: ghost");
  });

  test("happy path: filters removed agents from local config", async () => {
    writeWsFile("ws-u", {
      id: "ws-u", name: "u", hubUrl: "https://h.example",
      sharedAgents: ["alice", "bob", "carol"], joinedAt: "t",
    });
    curlStubs = [{ match: /agents/, response: { ok: true, data: null } }];

    await run(() => cmdWorkspaceUnshare(["bob"], "ws-u"));

    expect(exitCode).toBeUndefined();
    const body = JSON.parse((curlCalls[0].opts as { body: string }).body);
    expect(body.action).toBe("unshare");
    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-u.json"), "utf-8"));
    expect(saved.sharedAgents).toEqual(["alice", "carol"]);
    expect(outs.join("\n")).toContain("removed 1 agent(s)");
  });

  test("hub failure → exit 1, local unchanged", async () => {
    writeWsFile("ws-uf", {
      id: "ws-uf", name: "uf", hubUrl: "https://h.example",
      sharedAgents: ["alice"], joinedAt: "t",
    });
    curlStubs = [{ match: /agents/, response: { ok: false, status: 500, data: null } }];

    await run(() => cmdWorkspaceUnshare(["alice"], "ws-uf"));

    expect(exitCode).toBe(1);
    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-uf.json"), "utf-8"));
    expect(saved.sharedAgents).toEqual(["alice"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-agents.ts — cmdWorkspaceAgents
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceAgents", () => {
  test("no workspace → exit 1", async () => {
    await run(() => cmdWorkspaceAgents());
    expect(exitCode).toBe(1);
  });

  test("workspace not found → exit 1", async () => {
    await run(() => cmdWorkspaceAgents("ghost"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("workspace not found: ghost");
  });

  test("empty nodes dict → 'No agents' hint", async () => {
    writeWsFile("ws-a0", { id: "ws-a0", name: "empty", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /agents/, response: { ok: true, data: { nodes: {} } } }];

    await run(() => cmdWorkspaceAgents("ws-a0"));

    expect(exitCode).toBeUndefined();
    expect(outs.join("\n")).toContain("No agents in workspace yet");
    expect(outs.join("\n")).toContain("maw workspace share");
  });

  test("populated nodes → renders agents grouped by node with counts", async () => {
    writeWsFile("ws-a1", { id: "ws-a1", name: "grp", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{
      match: /agents/,
      response: {
        ok: true,
        data: { nodes: { white: ["alice", "bob"], mba: ["carol"] } },
      },
    }];

    await run(() => cmdWorkspaceAgents("ws-a1"));

    const joined = outs.join("\n");
    expect(joined).toContain("grp");
    expect(joined).toContain("white");
    expect(joined).toContain("(2 agents)");
    expect(joined).toContain("mba");
    expect(joined).toContain("(1 agent)"); // singular
    expect(joined).toContain("alice");
    expect(joined).toContain("carol");
    expect(joined).toContain("3 total agents across 2 nodes");
  });

  test("single-node singular wording", async () => {
    writeWsFile("ws-a2", { id: "ws-a2", name: "s", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{
      match: /agents/,
      response: { ok: true, data: { nodes: { only: ["solo"] } } },
    }];

    await run(() => cmdWorkspaceAgents("ws-a2"));

    expect(outs.join("\n")).toContain("1 total agents across 1 node");
  });

  test("missing data.nodes → treated as empty", async () => {
    writeWsFile("ws-a3", { id: "ws-a3", name: "m", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /agents/, response: { ok: true, data: {} } }];

    await run(() => cmdWorkspaceAgents("ws-a3"));

    expect(outs.join("\n")).toContain("No agents in workspace yet");
  });

  test("hub failure → exit 1", async () => {
    writeWsFile("ws-af", { id: "ws-af", name: "f", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /agents/, response: { ok: false, status: 500, data: null } }];

    await run(() => cmdWorkspaceAgents("ws-af"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("failed to fetch agents");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-query.ts — cmdWorkspaceLs
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceLs", () => {
  test("empty state → onboarding hints", async () => {
    await run(() => cmdWorkspaceLs());
    const joined = outs.join("\n");
    expect(joined).toContain("No workspaces configured");
    expect(joined).toContain("maw workspace create");
    expect(joined).toContain("maw workspace join");
  });

  test("populated with shared agents → renders each workspace + agent list", async () => {
    writeWsFile("ws-l1", {
      id: "ws-l1", name: "one", hubUrl: "https://a.example",
      sharedAgents: ["alice", "bob"], joinedAt: "2026-04-01", lastStatus: "connected",
    });
    writeWsFile("ws-l2", {
      id: "ws-l2", name: "two", hubUrl: "https://b.example",
      sharedAgents: [], joinedAt: "2026-04-02", lastStatus: "disconnected",
    });

    await run(() => cmdWorkspaceLs());

    const joined = outs.join("\n");
    expect(joined).toContain("Workspaces");
    expect(joined).toContain("2 joined");
    expect(joined).toContain("one");
    expect(joined).toContain("two");
    expect(joined).toContain("alice, bob");
    expect(joined).toContain("no agents shared");
    // connected dot = green, disconnected = red
    expect(joined).toContain("\x1b[32m\u25cf\x1b[0m");
    expect(joined).toContain("\x1b[31m\u25cf\x1b[0m");
  });

  test("single-agent singular wording ('1 agent shared')", async () => {
    writeWsFile("ws-l3", {
      id: "ws-l3", name: "solo", hubUrl: "https://h.example",
      sharedAgents: ["alice"], joinedAt: "t",
    });

    await run(() => cmdWorkspaceLs());

    expect(outs.join("\n")).toContain("1 agent shared");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-query.ts — cmdWorkspaceInvite
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceInvite", () => {
  test("no workspace → exit 1", async () => {
    await run(() => cmdWorkspaceInvite());
    expect(exitCode).toBe(1);
  });

  test("workspace not found → exit 1", async () => {
    await run(() => cmdWorkspaceInvite("ghost"));
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("workspace not found: ghost");
  });

  test("hub failure → exit 1", async () => {
    writeWsFile("ws-i0", { id: "ws-i0", name: "x", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /status/, response: { ok: false, status: 500, data: null } }];

    await run(() => cmdWorkspaceInvite("ws-i0"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("failed to fetch invite info");
  });

  test("happy path: prints joinCode + expiry + maw workspace join hint", async () => {
    writeWsFile("ws-i1", { id: "ws-i1", name: "inv", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{
      match: /status/,
      response: { ok: true, data: { joinCode: "CODE-111", expiry: "2026-05-01T00:00:00Z" } },
    }];

    await run(() => cmdWorkspaceInvite("ws-i1"));

    expect(exitCode).toBeUndefined();
    const joined = outs.join("\n");
    expect(joined).toContain("inv");
    expect(joined).toContain("CODE-111");
    expect(joined).toContain("Expires:");
    expect(joined).toContain("2026-05-01T00:00:00Z");
    expect(joined).toContain("maw workspace join CODE-111 --hub https://h.example");
  });

  test("server omits joinCode → falls back to local ws.joinCode", async () => {
    writeWsFile("ws-i2", {
      id: "ws-i2", name: "fb", hubUrl: "https://h.example",
      joinCode: "LOCAL-CODE", sharedAgents: [], joinedAt: "t",
    });
    curlStubs = [{ match: /status/, response: { ok: true, data: {} } }];

    await run(() => cmdWorkspaceInvite("ws-i2"));

    expect(exitCode).toBeUndefined();
    expect(outs.join("\n")).toContain("LOCAL-CODE");
  });

  test("no joinCode anywhere → exit 1", async () => {
    writeWsFile("ws-i3", {
      id: "ws-i3", name: "nojc", hubUrl: "https://h.example",
      sharedAgents: [], joinedAt: "t",
    });
    curlStubs = [{ match: /status/, response: { ok: true, data: {} } }];

    await run(() => cmdWorkspaceInvite("ws-i3"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("no join code available");
  });

  test("no expiry returned → 'Expires:' line not printed", async () => {
    writeWsFile("ws-i4", { id: "ws-i4", name: "noe", hubUrl: "https://h.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /status/, response: { ok: true, data: { joinCode: "JC" } } }];

    await run(() => cmdWorkspaceInvite("ws-i4"));

    expect(outs.some(o => o.includes("Expires:"))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// workspace-query.ts — cmdWorkspaceStatus
// ════════════════════════════════════════════════════════════════════════════

describe("cmdWorkspaceStatus", () => {
  test("empty → 'No workspaces configured'", async () => {
    await run(() => cmdWorkspaceStatus());
    expect(outs.join("\n")).toContain("No workspaces configured");
  });

  test("connected response → connected dot, updates lastStatus in file", async () => {
    writeWsFile("ws-st1", { id: "ws-st1", name: "up", hubUrl: "https://up.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{
      match: /up\.example/,
      response: { ok: true, data: { agentCount: 3, nodeCount: 2 } },
    }];

    await run(() => cmdWorkspaceStatus());

    const joined = outs.join("\n");
    expect(joined).toContain("up");
    expect(joined).toContain("connected");
    expect(joined).toContain("3 agents");
    expect(joined).toContain("2 nodes");
    expect(joined).toContain("1/1 connected");

    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-st1.json"), "utf-8"));
    expect(saved.lastStatus).toBe("connected");
  });

  test("hub non-ok → disconnected, lastStatus persisted", async () => {
    writeWsFile("ws-st2", { id: "ws-st2", name: "down", hubUrl: "https://down.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{
      match: /down\.example/,
      response: { ok: false, status: 502, data: null },
    }];

    await run(() => cmdWorkspaceStatus());

    expect(outs.join("\n")).toContain("disconnected");
    expect(outs.join("\n")).toContain("0/1 connected");
    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-st2.json"), "utf-8"));
    expect(saved.lastStatus).toBe("disconnected");
  });

  test("curlFetch throws → caught, marked disconnected", async () => {
    writeWsFile("ws-st3", { id: "ws-st3", name: "boom", hubUrl: "https://boom.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /boom\.example/, error: "network down" }];

    await run(() => cmdWorkspaceStatus());

    expect(outs.join("\n")).toContain("disconnected");
    const saved = JSON.parse(readFileSync(join(WS_DIR, "ws-st3.json"), "utf-8"));
    expect(saved.lastStatus).toBe("disconnected");
  });

  test("mixed connected/disconnected → totals reflect count", async () => {
    writeWsFile("ws-m1", { id: "ws-m1", name: "ok", hubUrl: "https://ok.example", sharedAgents: [], joinedAt: "t" });
    writeWsFile("ws-m2", { id: "ws-m2", name: "bad", hubUrl: "https://bad.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [
      { match: /ok\.example/, response: { ok: true, data: { agentCount: 1, nodeCount: 1 } } },
      { match: /bad\.example/, response: { ok: false, status: 500, data: null } },
    ];

    await run(() => cmdWorkspaceStatus());

    expect(outs.join("\n")).toContain("1/2 connected");
  });

  test("singular wording when agentCount=1 and nodeCount=1", async () => {
    writeWsFile("ws-m3", { id: "ws-m3", name: "sing", hubUrl: "https://s.example", sharedAgents: [], joinedAt: "t" });
    curlStubs = [{ match: /s\.example/, response: { ok: true, data: { agentCount: 1, nodeCount: 1 } } }];

    await run(() => cmdWorkspaceStatus());

    const joined = outs.join("\n");
    expect(joined).toMatch(/1 agent\b/); // singular
    expect(joined).toMatch(/1 node\b/);
  });
});
