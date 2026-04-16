/**
 * comm-peek.ts — resolveSearchSessions + cmdPeek (maw peek <target>).
 *
 *   resolveSearchSessions(query, sessions): prefers config.sessions mapping,
 *     then fleet-session lookup, else all sessions.
 *   cmdPeek(query?): normalizes query, surfaces bare-name tip, detects
 *     node:agent federation (local-prefix strip / remote curlFetch / peer
 *     fallthrough), prints fleet overview on no-arg, otherwise resolves
 *     findWindow → capture → stdout.
 *
 * Isolated because we mock.module on four seams cmd-peek imports through:
 *   - src/sdk             (listSessions, capture, findWindow, curlFetch)
 *   - src/config          (loadConfig)
 *   - src/commands/shared/wake (resolveFleetSession)
 *   - src/core/transport/ssh   (defensive — sdk re-exports through here)
 *
 * mock.module is process-global → capture REAL fn refs before install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 *
 * process.exit is stubbed into a throw so the harness can observe branches
 * that would otherwise tear the runner down (federation-peek failure,
 * window-not-found).
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rSdk = await import("../../src/sdk");
const realListSessions = _rSdk.listSessions;
const realCapture = _rSdk.capture;
const realFindWindow = _rSdk.findWindow;
const realCurlFetch = _rSdk.curlFetch;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

const _rWake = await import("../../src/commands/shared/wake");
const realResolveFleetSession = _rWake.resolveFleetSession;

const _rSsh = await import("../../src/core/transport/ssh");
const realHostExec = _rSsh.hostExec;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

interface PaneWindow { index: number; name: string; active: boolean; }
interface PaneSession { name: string; windows: PaneWindow[]; }

let listSessionsReturn: PaneSession[] = [];
let captureCalls: Array<{ target: string; lines: number | undefined }> = [];
let captureResponses: Array<{ match: RegExp; result?: string; error?: string }> = [];
let findWindowReturn: string | null = null;
let findWindowCalls: Array<{ sessions: PaneSession[]; query: string }> = [];
let curlFetchCalls: Array<{ url: string; opts: unknown }> = [];
let curlFetchResponses: Array<{ match: RegExp; response: { ok: boolean; status: number; data: unknown } }> = [];

let configOverride: Record<string, unknown> = {};
let resolveFleetSessionMap: Record<string, string | null> = {};
let resolveFleetSessionCalls: string[] = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    listSessions: async (...args: unknown[]) => {
      if (!mockActive) return (realListSessions as (...a: unknown[]) => Promise<PaneSession[]>)(...args);
      return listSessionsReturn;
    },
    capture: async (...args: unknown[]) => {
      if (!mockActive) return (realCapture as (...a: unknown[]) => Promise<string>)(...args);
      const [target, lines] = args as [string, number | undefined];
      captureCalls.push({ target, lines });
      for (const r of captureResponses) {
        if (r.match.test(target)) {
          if (r.error) throw new Error(r.error);
          return r.result ?? "";
        }
      }
      return "";
    },
    findWindow: (...args: unknown[]) => {
      if (!mockActive) return (realFindWindow as (...a: unknown[]) => string | null)(...args);
      const [sessions, query] = args as [PaneSession[], string];
      findWindowCalls.push({ sessions, query });
      return findWindowReturn;
    },
    curlFetch: async (...args: unknown[]) => {
      if (!mockActive) return (realCurlFetch as (...a: unknown[]) => unknown)(...args);
      const [url, opts] = args as [string, unknown];
      curlFetchCalls.push({ url, opts });
      for (const r of curlFetchResponses) {
        if (r.match.test(url)) return r.response;
      }
      return { ok: false, status: 0, data: null };
    },
  }),
);

// Defensive ssh mock — sdk re-exports through here; bud-wake + split-cascade
// also mock this module. Passthrough on mockActive=false keeps those green.
mock.module(
  join(import.meta.dir, "../../src/core/transport/ssh"),
  () => ({
    ..._rSsh,
    hostExec: async (...args: unknown[]) => {
      if (!mockActive) return (realHostExec as (...a: unknown[]) => Promise<string>)(...args);
      return "";
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
  join(import.meta.dir, "../../src/commands/shared/wake"),
  () => ({
    ..._rWake,
    resolveFleetSession: (...args: unknown[]) => {
      if (!mockActive) return (realResolveFleetSession as (...a: unknown[]) => string | null)(...args);
      const name = args[0] as string;
      resolveFleetSessionCalls.push(name);
      return name in resolveFleetSessionMap ? resolveFleetSessionMap[name]! : null;
    },
  }),
);

// NB: import target AFTER mocks so its import graph resolves through our stubs.
const { cmdPeek, resolveSearchSessions } = await import("../../src/commands/shared/comm-peek");

// ─── Harness ────────────────────────────────────────────────────────────────

const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;
const origQuiet = process.env.MAW_QUIET;

let outs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

/** Run fn, capturing console output + process.exit via a throw. */
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

beforeEach(() => {
  mockActive = true;
  listSessionsReturn = [];
  captureCalls = [];
  captureResponses = [];
  findWindowReturn = null;
  findWindowCalls = [];
  curlFetchCalls = [];
  curlFetchResponses = [];
  configOverride = {};
  resolveFleetSessionMap = {};
  resolveFleetSessionCalls = [];
  delete process.env.MAW_QUIET;
});

afterEach(() => {
  mockActive = false;
  if (origQuiet === undefined) delete process.env.MAW_QUIET;
  else process.env.MAW_QUIET = origQuiet;
});

afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origErr;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

// ─── resolveSearchSessions ──────────────────────────────────────────────────

describe("resolveSearchSessions", () => {
  const sessions: PaneSession[] = [
    { name: "05-neo", windows: [{ index: 0, name: "neo-oracle", active: true }] },
    { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: false }] },
    { name: "99-other", windows: [{ index: 0, name: "other", active: false }] },
  ];

  test("config.sessions mapping hits → filters to mapped session", () => {
    configOverride = { sessions: { mawjs: "08-mawjs" } };
    const out = resolveSearchSessions("mawjs", sessions);
    expect(out.map((s) => s.name)).toEqual(["08-mawjs"]);
  });

  test("config.sessions maps to a name absent from session list → falls through to fleet", () => {
    configOverride = { sessions: { mawjs: "42-missing" } };
    resolveFleetSessionMap = { mawjs: "08-mawjs" };
    const out = resolveSearchSessions("mawjs", sessions);
    expect(out.map((s) => s.name)).toEqual(["08-mawjs"]);
    expect(resolveFleetSessionCalls).toEqual(["mawjs"]);
  });

  test("no config mapping + resolveFleetSession returns name found in list → filters", () => {
    configOverride = { sessions: {} };
    resolveFleetSessionMap = { mawjs: "08-mawjs" };
    const out = resolveSearchSessions("mawjs", sessions);
    expect(out.map((s) => s.name)).toEqual(["08-mawjs"]);
  });

  test("no config mapping + fleet session name not in list → returns all sessions", () => {
    configOverride = { sessions: {} };
    resolveFleetSessionMap = { mawjs: "77-ghost" };
    const out = resolveSearchSessions("mawjs", sessions);
    expect(out).toBe(sessions);
  });

  test("no mapping + no fleet match → returns full session array (identity)", () => {
    configOverride = { sessions: {} };
    const out = resolveSearchSessions("random", sessions);
    expect(out).toBe(sessions);
  });

  test("handles loadConfig returning no sessions key (undefined) without throwing", () => {
    configOverride = {}; // no .sessions at all
    const out = resolveSearchSessions("random", sessions);
    expect(out).toBe(sessions);
  });
});

// ─── cmdPeek — normalization + bare-name tip (#362b) ────────────────────────

describe("cmdPeek — bare-name tip (#362b)", () => {
  test("bare name + config.node set + no MAW_QUIET → tip on stderr", async () => {
    configOverride = { node: "white", sessions: {} };
    listSessionsReturn = [];
    findWindowReturn = null;

    await run(() => cmdPeek("mawjs"));

    const joined = errs.join("\n");
    expect(joined).toContain("tip");
    expect(joined).toContain("maw peek white:mawjs");
  });

  test("MAW_QUIET=1 suppresses the tip", async () => {
    process.env.MAW_QUIET = "1";
    configOverride = { node: "white", sessions: {} };
    listSessionsReturn = [];
    findWindowReturn = null;

    await run(() => cmdPeek("mawjs"));

    expect(errs.some((e) => e.includes("tip"))).toBe(false);
  });

  test("no config.node → no tip (nothing to prefix with)", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [];
    findWindowReturn = null;

    await run(() => cmdPeek("mawjs"));

    expect(errs.some((e) => e.includes("tip"))).toBe(false);
  });

  test("query containing ':' → no tip (already canonical)", async () => {
    configOverride = { node: "white", sessions: {} };
    // Falls through to local (local-node-prefix branch strips the prefix).
    await run(() => cmdPeek("white:mawjs"));

    expect(errs.some((e) => e.includes("tip"))).toBe(false);
  });

  test("query containing '/' → no tip (org/repo-shaped input)", async () => {
    configOverride = { node: "white", sessions: {} };
    listSessionsReturn = [];
    findWindowReturn = null;

    await run(() => cmdPeek("org/repo"));

    expect(errs.some((e) => e.includes("tip"))).toBe(false);
  });

  test("normalizeTarget strips trailing slash before tip test", async () => {
    configOverride = { node: "white", sessions: {} };
    listSessionsReturn = [];
    findWindowReturn = null;

    await run(() => cmdPeek("mawjs/"));

    // Tip still shown, but with the normalized (slash-stripped) name.
    expect(errs.some((e) => e.includes("maw peek white:mawjs") && !e.includes("mawjs/"))).toBe(true);
  });
});

// ─── cmdPeek — node:agent federation ────────────────────────────────────────

describe("cmdPeek — federation (node:agent)", () => {
  test("local-node prefix is stripped → falls through to local peek", async () => {
    configOverride = { node: "white", sessions: {} };
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    findWindowReturn = "08-mawjs:0";
    captureResponses = [{ match: /08-mawjs:0/, result: "local pane body" }];

    await run(() => cmdPeek("white:mawjs"));

    // No curlFetch — we routed locally.
    expect(curlFetchCalls).toHaveLength(0);
    // findWindow called with the STRIPPED query "mawjs"
    expect(findWindowCalls).toHaveLength(1);
    expect(findWindowCalls[0].query).toBe("mawjs");
    expect(outs.some((o) => o.includes("local pane body"))).toBe(true);
  });

  test("namedPeers hit → curlFetch(peerUrl + /api/capture?target=) + prints content", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      namedPeers: [{ name: "white", url: "https://white.example" }],
    };
    curlFetchResponses = [{
      match: /white\.example.*target=mawjs/,
      response: { ok: true, status: 200, data: { content: "remote pane content" } },
    }];

    await run(() => cmdPeek("white:mawjs"));

    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("https://white.example/api/capture?target=mawjs");
    expect(outs.some((o) => o.includes("white:mawjs") && o.includes("(white)"))).toBe(true);
    expect(outs.some((o) => o.includes("remote pane content"))).toBe(true);
    // Did NOT fall through to local: listSessions never called.
    expect(findWindowCalls).toHaveLength(0);
  });

  test("agentName encoded into URL (special chars)", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      namedPeers: [{ name: "white", url: "https://white.example" }],
    };
    curlFetchResponses = [{
      match: /target=/,
      response: { ok: true, status: 200, data: { content: "x" } },
    }];

    await run(() => cmdPeek("white:name with space"));

    expect(curlFetchCalls[0].url).toContain("target=name%20with%20space");
  });

  test("peers array fallback (no namedPeers) → matches by substring", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      peers: ["https://white.example:3456"],
    };
    curlFetchResponses = [{
      match: /white\.example.*target=mawjs/,
      response: { ok: true, status: 200, data: { content: "via peers[]" } },
    }];

    await run(() => cmdPeek("white:mawjs"));

    expect(curlFetchCalls).toHaveLength(1);
    expect(outs.some((o) => o.includes("via peers[]"))).toBe(true);
  });

  test("curlFetch returns ok:false → error on stderr + exit 1", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      namedPeers: [{ name: "white", url: "https://white.example" }],
    };
    curlFetchResponses = [{
      match: /white\.example/,
      response: { ok: false, status: 500, data: { error: "peer down" } },
    }];

    await run(() => cmdPeek("white:mawjs"));

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain("capture failed");
    expect(joined).toContain("mawjs");
    expect(joined).toContain("white");
    expect(joined).toContain("peer down");
  });

  test("curlFetch ok:true but data.content missing → still treated as failure + exit 1", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      namedPeers: [{ name: "white", url: "https://white.example" }],
    };
    curlFetchResponses = [{
      match: /white\.example/,
      response: { ok: true, status: 200, data: {} }, // no content field
    }];

    await run(() => cmdPeek("white:mawjs"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("capture failed");
  });

  test("no peer matches node name → falls through to local lookup (does NOT exit)", async () => {
    configOverride = {
      node: "mba",
      sessions: {},
      namedPeers: [{ name: "other", url: "https://other.example" }],
      peers: [],
    };
    listSessionsReturn = [
      { name: "01-foo", windows: [{ index: 0, name: "foo", active: true }] },
    ];
    findWindowReturn = null;

    await run(() => cmdPeek("ghost:mawjs"));

    // No federation call
    expect(curlFetchCalls).toHaveLength(0);
    // Fell through to local: listSessions + findWindow used; findWindow miss → exit 1
    expect(findWindowCalls).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("window not found: ghost:mawjs");
  });
});

// ─── cmdPeek — no-arg fleet overview ────────────────────────────────────────

describe("cmdPeek — fleet overview (no query)", () => {
  test("prints one compact line per window with last non-empty capture line", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      {
        name: "05-neo",
        windows: [
          { index: 0, name: "neo-oracle", active: true },
          { index: 1, name: "neo-helper", active: false },
        ],
      },
    ];
    captureResponses = [
      { match: /05-neo:0/, result: "prompt $\nclaude says hi" },
      { match: /05-neo:1/, result: "running tests\n" },
    ];

    await run(() => cmdPeek());

    expect(captureCalls).toEqual([
      { target: "05-neo:0", lines: 3 },
      { target: "05-neo:1", lines: 3 },
    ]);
    const joined = outs.join("\n");
    expect(joined).toContain("neo-oracle");
    expect(joined).toContain("claude says hi");
    expect(joined).toContain("neo-helper");
    expect(joined).toContain("running tests");
  });

  test("active window line begins with '*' marker; inactive uses space", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      {
        name: "05-neo",
        windows: [
          { index: 0, name: "active-win", active: true },
          { index: 1, name: "idle-win", active: false },
        ],
      },
    ];
    captureResponses = [
      { match: /05-neo:0/, result: "x" },
      { match: /05-neo:1/, result: "y" },
    ];

    await run(() => cmdPeek());

    const activeLine = outs.find((l) => l.includes("active-win"))!;
    const idleLine = outs.find((l) => l.includes("idle-win"))!;
    expect(activeLine.includes("*")).toBe(true);
    // Inactive line shouldn't carry the green asterisk marker. The exact
    // escape sequence `\x1b[32m*\x1b[0m` only appears on the active line.
    expect(idleLine.includes("\x1b[32m*\x1b[0m")).toBe(false);
  });

  test("capture throws → '(unreachable)' line rendered instead", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      {
        name: "05-neo",
        windows: [{ index: 0, name: "dead-win", active: false }],
      },
    ];
    captureResponses = [{ match: /05-neo:0/, error: "tmux refused" }];

    await run(() => cmdPeek());

    expect(outs.some((o) => o.includes("dead-win") && o.includes("(unreachable)"))).toBe(true);
  });

  test("capture returns only blank lines → '(empty)' fallback", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      {
        name: "05-neo",
        windows: [{ index: 0, name: "blank-win", active: false }],
      },
    ];
    captureResponses = [{ match: /05-neo:0/, result: "\n\n   \n" }];

    await run(() => cmdPeek());

    expect(outs.some((o) => o.includes("blank-win") && o.includes("(empty)"))).toBe(true);
  });

  test("empty session list → no output, no crash", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [];

    await run(() => cmdPeek());

    expect(outs).toEqual([]);
    expect(exitCode).toBeUndefined();
  });
});

// ─── cmdPeek — local single-target peek ─────────────────────────────────────

describe("cmdPeek — local single-target peek", () => {
  test("findWindow hits → capture + prints header and body", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    findWindowReturn = "08-mawjs:0";
    captureResponses = [{ match: /08-mawjs:0/, result: "pane body here" }];

    await run(() => cmdPeek("mawjs"));

    expect(findWindowCalls).toHaveLength(1);
    expect(findWindowCalls[0].query).toBe("mawjs");
    expect(captureCalls.some((c) => c.target === "08-mawjs:0")).toBe(true);
    const joined = outs.join("\n");
    expect(joined).toContain("--- 08-mawjs:0 ---");
    expect(joined).toContain("pane body here");
  });

  test("findWindow miss → error on stderr + exit 1 (capture NOT called)", async () => {
    configOverride = { sessions: {} };
    listSessionsReturn = [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    findWindowReturn = null;

    await run(() => cmdPeek("ghostname"));

    expect(exitCode).toBe(1);
    expect(errs.some((e) => e.includes("window not found: ghostname"))).toBe(true);
    expect(captureCalls).toHaveLength(0);
  });

  test("resolveSearchSessions narrows findWindow input when config.sessions maps query", async () => {
    configOverride = { sessions: { mawjs: "08-mawjs" } };
    listSessionsReturn = [
      { name: "05-neo", windows: [{ index: 0, name: "neo-oracle", active: false }] },
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
    ];
    findWindowReturn = "08-mawjs:0";
    captureResponses = [{ match: /08-mawjs:0/, result: "body" }];

    await run(() => cmdPeek("mawjs"));

    // findWindow invoked with only the mapped session — not all sessions.
    expect(findWindowCalls).toHaveLength(1);
    expect(findWindowCalls[0].sessions.map((s) => s.name)).toEqual(["08-mawjs"]);
  });
});
