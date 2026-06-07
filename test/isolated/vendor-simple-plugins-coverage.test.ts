import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fleetDir = mkdtempSync(join(tmpdir(), "maw-vendor-simple-fleet-"));

type Session = {
  name: string;
  windows?: Array<{ index: number; name: string }>;
};

type ResolveOracleResult = {
  repoPath: string | null;
  repoName: string;
  parentDir: string | null;
};

type PeerCallResult = {
  ok: boolean;
  status?: number;
  data?: any;
};

const aboutHelpersPath = import.meta.resolve("../../src/vendor/mpr-plugins/about/internal/impl-helpers.ts");
const pairPeersImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/peers-impl.ts");
const pairHandshakePath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/handshake.ts");
const killImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/kill/impl.ts");
const peerResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-resolve.ts");
const peerCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-call.ts");

let sessions: Session[] = [];
let detectedSession: string | null = null;
let resolveResult: ResolveOracleResult = { repoPath: null, repoName: "", parentDir: null };
let worktrees: Array<{ name: string; path: string }> = [];
let captureByTarget = new Map<string, string | Error>();
let resolveCalls: string[] = [];
let detectCalls: string[] = [];
let findWorktreeCalls: Array<{ parentDir: string; repoName: string }> = [];
let captureCalls: Array<{ target: string; lines: number }> = [];
let hostExecCalls: string[] = [];

let config = { port: 3456, node: "local" };
let postHandshakeResult: { ok: true; node: string; url: string } | { ok: false; error: string; status: number } = {
  ok: true,
  node: "remote",
  url: "http://remote",
};
let warnCalls: string[] = [];
let addCalls: Array<{ alias: string; url: string; node: string }> = [];
let cmdAddError: Error | null = null;

let killCalls: Array<{ target: string; opts: { pane?: number } }> = [];
let killError: Error | null = null;
let peersByAlias = new Map<string, { url: string; node: string | null }>();
let peerKillResult: PeerCallResult = { ok: true, data: {} };
let peerKillError: Error | null = null;
let peerKillCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

let logs: string[] = [];
let errors: string[] = [];
let warns: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;

function loadTestFleetEntries() {
  return readdirSync(fleetDir)
    .filter(file => file.endsWith(".json") && !file.endsWith(".disabled"))
    .sort()
    .map(file => {
      const match = file.match(/^(\d+)-(.+)\.json$/);
      return {
        file,
        path: join(fleetDir, file),
        num: match ? Number.parseInt(match[1], 10) : 0,
        groupName: match ? match[2] : file.replace(/\.json$/, ""),
        session: JSON.parse(readFileSync(join(fleetDir, file), "utf-8") || "{}"),
      };
    });
}

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: loadTestFleetEntries,
}));

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  listSessions: async () => sessions,
  capture: async (target: string, lines: number) => {
    captureCalls.push({ target, lines });
    const value = captureByTarget.get(target);
    if (value instanceof Error) throw value;
    return value ?? "";
  },
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "";
  },
  tmuxCmd: () => "tmux",
}));

mock.module("maw-js/commands/shared/wake", () => ({
  detectSession: async (name: string) => {
    detectCalls.push(name);
    return detectedSession;
  },
  findWorktrees: async (parentDir: string, repoName: string) => {
    findWorktreeCalls.push({ parentDir, repoName });
    return worktrees;
  },
}));

mock.module(aboutHelpersPath, () => ({
  resolveOracleSafe: async (name: string) => {
    resolveCalls.push(name);
    return resolveResult;
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module(pairPeersImplPath, () => ({
  cmdAdd: async (entry: { alias: string; url: string; node: string }) => {
    addCalls.push(entry);
    if (cmdAddError) throw cmdAddError;
  },
}));

mock.module(pairHandshakePath, () => ({
  postHandshake: async () => postHandshakeResult,
  warnIfPlainHttp: (url: string) => {
    warnCalls.push(url);
  },
}));

mock.module(killImplPath, () => ({
  cmdKill: async (target: string, opts: { pane?: number } = {}) => {
    killCalls.push({ target, opts });
    if (killError) throw killError;
    if (target === "stderr") {
      console.error("stderr kill log");
      return;
    }
    console.log(`killed ${target}${opts.pane === undefined ? "" : ` pane ${opts.pane}`}`);
  },
}));

mock.module(peerResolvePath, () => ({
  resolvePeer: (alias: string) => peersByAlias.get(alias) ?? null,
}));

mock.module(peerCallPath, () => ({
  callPeerKill: async (url: string, body: Record<string, unknown>) => {
    peerKillCalls.push({ url, body });
    if (peerKillError) throw peerKillError;
    return peerKillResult;
  },
}));

const { cmdOracleAbout } = await import(
  "../../src/vendor/mpr-plugins/about/internal/impl-about.ts?vendor-simple-plugins-coverage"
);
const pairImpl = await import("../../src/vendor/mpr-plugins/pair/impl.ts?vendor-simple-plugins-coverage");
const killPlugin = await import("../../src/vendor/mpr-plugins/kill/index.ts?vendor-simple-plugins-coverage");
const killHandler = killPlugin.default;

function resetConsoleCapture() {
  logs = [];
  errors = [];
  warns = [];
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: any[]) => warns.push(args.map(String).join(" "));
}

function resetFleetDir() {
  rmSync(fleetDir, { recursive: true, force: true });
  mkdirSync(fleetDir, { recursive: true });
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function output() {
  return [...logs, ...errors, ...warns].join("\n");
}

function writeFleet(file: string, windows: Array<{ name: string }>) {
  writeFileSync(join(fleetDir, file), JSON.stringify({ windows }, null, 2), "utf-8");
}

function makeCtx(source: "cli" | "api", args: unknown, writer?: (...args: any[]) => void) {
  return { source, args, writer } as any;
}

beforeEach(() => {
  resetFleetDir();
  sessions = [];
  detectedSession = null;
  resolveResult = { repoPath: null, repoName: "", parentDir: null };
  worktrees = [];
  captureByTarget = new Map();
  resolveCalls = [];
  detectCalls = [];
  findWorktreeCalls = [];
  captureCalls = [];
  hostExecCalls = [];

  config = { port: 4567, node: "local-node" };
  postHandshakeResult = { ok: true, node: "remote-node", url: "http://remote-node" };
  warnCalls = [];
  addCalls = [];
  cmdAddError = null;

  killCalls = [];
  killError = null;
  peersByAlias = new Map();
  peerKillResult = { ok: true, data: {} };
  peerKillError = null;
  peerKillCalls = [];

  globalThis.fetch = originalFetch;
  resetConsoleCapture();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  rmSync(fleetDir, { recursive: true, force: true });
});

describe("vendor about/internal/impl-about coverage", () => {
  test("rejects an unknown oracle when repo, session, and fleet signals are absent", async () => {
    await expect(cmdOracleAbout("GhostCase")).rejects.toThrow("no oracle named 'GhostCase' — try: maw oracle ls");

    expect(resolveCalls).toEqual(["ghostcase"]);
    expect(detectCalls).toEqual(["ghostcase"]);
    expect(output()).toBe("");
  });

  test("renders repo/session/worktrees/fleet details and unregistered window warnings", async () => {
    resolveResult = { repoPath: "/repo/mawjs", repoName: "mawjs", parentDir: "/repo" };
    detectedSession = "mawjs-live";
    sessions = [{
      name: "mawjs-live",
      windows: [
        { index: 0, name: "mawjs-oracle" },
        { index: 1, name: "scratch" },
        { index: 2, name: "stale" },
      ],
    }];
    worktrees = [
      { name: "alpha", path: "/repo/mawjs" },
      { name: "fix", path: "/repo/mawjs-fix" },
    ];
    captureByTarget.set("mawjs-live:0", "ready\n");
    captureByTarget.set("mawjs-live:1", "   ");
    captureByTarget.set("mawjs-live:2", new Error("pane missing"));
    writeFleet("mawjs.json", [{ name: "mawjs-oracle" }]);

    await cmdOracleAbout("mawjs");

    const plain = stripAnsi(output());
    expect(plain).toContain("Oracle — mawjs");
    expect(plain).toContain("Repo:      /repo/mawjs");
    expect(plain).toContain("Session:   mawjs-live (3 windows)");
    expect(plain).toContain("● mawjs-oracle");
    expect(plain).toContain("● scratch");
    expect(plain).toContain("○ stale");
    expect(plain).toContain("Worktrees: 2");
    expect(plain).toContain("alpha → /repo/mawjs");
    expect(plain).toContain("Fleet:     mawjs.json (1 registered, 3 running)");
    expect(plain).toContain("2 window(s) not in fleet config");
    expect(plain).toContain("→ scratch");
    expect(plain).toContain("→ stale");
    expect(captureCalls).toEqual([
      { target: "mawjs-live:0", lines: 3 },
      { target: "mawjs-live:1", lines: 3 },
      { target: "mawjs-live:2", lines: 3 },
    ]);
    expect(findWorktreeCalls).toEqual([{ parentDir: "/repo", repoName: "mawjs" }]);
  });

  test("uses fleet membership as a valid signal without repo/session and tolerates unreadable fleet data", async () => {
    writeFleet("remote.json", [{ name: "Remote" }]);

    await cmdOracleAbout("Remote");

    expect(stripAnsi(output())).toContain("Fleet:     remote.json (1 registered, 0 running)");
    expect(findWorktreeCalls).toEqual([]);
    logs = [];

    resetFleetDir();
    writeFileSync(join(fleetDir, "bad.json"), "{", "utf-8");
    resolveResult = { repoPath: "/repo/sparse", repoName: "sparse", parentDir: null };

    await cmdOracleAbout("Sparse");

    const plain = stripAnsi(output());
    expect(plain).toContain("Repo:      /repo/sparse");
    expect(plain).toContain("Session:   (none)");
    expect(plain).toContain("Fleet:     (no config)");
  });
});

describe("vendor pair/impl coverage", () => {
  test("pairGenerate reports network and non-ok generate failures", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;

    await expect(pairImpl.pairGenerate()).resolves.toEqual({
      ok: false,
      error: "cannot reach local server at http://localhost:4567: connection refused (is 'maw serve' running?)",
    });

    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as any;

    await expect(pairImpl.pairGenerate({ localUrl: "http://local.test" })).resolves.toEqual({
      ok: false,
      error: "generate failed: 503",
    });
  });

  test("pairGenerate prints code details and returns consumed status when acceptor arrives", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      fetchCalls.push(String(url));
      if (fetchCalls.length === 1) {
        return Response.json({ code: "ABC123", expiresAt: Date.now() + 5_000 });
      }
      return Response.json({ consumed: true, remoteNode: "buddy", remoteUrl: "http://buddy" });
    }) as any;

    const result = await pairImpl.pairGenerate({ localUrl: "http://local.test", pollIntervalMs: 0 });

    expect(result).toEqual({ ok: true, code: "ABC123", remoteNode: "buddy" });
    expect(fetchCalls).toEqual([
      "http://local.test/api/pair/generate",
      "http://local.test/api/pair/ABC123/status",
    ]);
    expect(output()).toContain("🤝 pair code: ABC123");
    expect(output()).toContain("listening on http://local.test/api/pair/ABC123");
    expect(output()).toContain("✅ paired with buddy at http://buddy");
  });

  test("pairGenerate handles expired status responses before the acceptor arrives", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return Response.json({ code: "ABC123", expiresAt: Date.now() + 5_000 });
      return new Response("expired", { status: 410 });
    }) as any;

    await expect(pairImpl.pairGenerate({ localUrl: "http://local.test", pollIntervalMs: 0 })).resolves.toEqual({
      ok: false,
      error: "code expired before acceptor arrived",
    });
  });

  test("pairGenerate ignores transient status-poll network failures until expiry", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return Response.json({ code: "ABC345", expiresAt: Date.now() + 25 });
      throw new Error("status offline");
    }) as any;

    await expect(pairImpl.pairGenerate({ localUrl: "http://local.test", pollIntervalMs: 0 })).resolves.toEqual({
      ok: false,
      error: "pair code expired — no acceptor",
    });
    expect(call).toBeGreaterThanOrEqual(2);
  });

  test("pairGenerate expires cleanly when status polling never reports consumption", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return Response.json({ code: "ABC234", expiresAt: Date.now() + 25 });
      return Response.json({ consumed: false });
    }) as any;

    await expect(pairImpl.pairGenerate({ localUrl: "http://local.test", pollIntervalMs: 0 })).resolves.toEqual({
      ok: false,
      error: "pair code expired — no acceptor",
    });
    expect(call).toBeGreaterThanOrEqual(2);
  });

  test("pairAccept validates URL, protocol, and code shape before posting", async () => {
    await expect(pairImpl.pairAccept("not-url", "ABC123")).resolves.toEqual({
      ok: false,
      error: 'invalid URL "not-url"',
    });
    await expect(pairImpl.pairAccept("ftp://peer", "ABC123")).resolves.toEqual({
      ok: false,
      error: 'invalid URL "ftp://peer" (must be http:// or https://)',
    });
    await expect(pairImpl.pairAccept("http://peer", "bad-code")).resolves.toEqual({
      ok: false,
      error: "invalid code shape: BAD-***",
    });

    expect(warnCalls).toEqual([]);
    expect(addCalls).toEqual([]);
  });

  test("pairAccept posts normalized handshakes, writes the peer, and reports write failures", async () => {
    const ok = await pairImpl.pairAccept("http://peer", "abc-234", { localUrl: "http://me.local" });

    expect(ok).toEqual({ ok: true, code: "ABC234", remoteNode: "remote-node" });
    expect(warnCalls).toEqual(["http://peer"]);
    expect(addCalls).toEqual([{ alias: "remote-node", url: "http://remote-node", node: "remote-node" }]);
    expect(output()).toContain("🤝 posting to http://peer/api/pair/ABC234 ...");
    expect(output()).toContain("✅ paired: remote-node ↔ local-node");

    cmdAddError = new Error("disk full");
    postHandshakeResult = { ok: true, node: "fallback-node", url: "" };

    await expect(pairImpl.pairAccept("https://peer", "ABC234")).resolves.toEqual({
      ok: false,
      error: "paired but peer write failed: disk full",
    });
    expect(addCalls.at(-1)).toEqual({ alias: "fallback-node", url: "https://peer", node: "fallback-node" });
  });

  test("pairAccept maps handshake failures to specific hints", async () => {
    const cases = [
      [410, "gone", "handshake failed: gone (code expired or already consumed)"],
      [404, "missing", "handshake failed: missing (code not found — check spelling or regenerate)"],
      [400, "bad", "handshake failed: bad (bad request — check code shape)"],
      [0, "offline", "handshake failed: offline (network unreachable — check URL + server running)"],
      [500, "boom", "handshake failed: boom"],
    ] as const;

    for (const [status, error, expected] of cases) {
      postHandshakeResult = { ok: false, status, error };
      await expect(pairImpl.pairAccept("https://peer", "ABC234")).resolves.toEqual({ ok: false, error: expected });
    }
  });
});

describe("vendor kill/index handler coverage", () => {
  test("exports command metadata and validates CLI target arguments", async () => {
    expect(killPlugin.command).toMatchObject({
      name: "kill",
      description: expect.stringContaining("Immediately kill"),
    });

    await expect(killHandler(makeCtx("cli", ["--help"]))).resolves.toEqual({
      ok: false,
      error: "usage: maw kill <target>[:window] [--pane N] [--peer <alias>]  (see: maw sleep for graceful stop, maw done for worktrees)",
    });

    await expect(killHandler(makeCtx("cli", ["--pane"]))).resolves.toEqual({
      ok: false,
      error: "option requires argument: --pane",
      output: undefined,
    });

    await expect(killHandler(makeCtx("cli", ["--bogus"]))).resolves.toEqual({
      ok: false,
      error: "\"--bogus\" looks like a flag, not a target.\n  usage: maw kill <target>  (see: maw sleep for graceful stop, maw done for worktrees)",
    });

    expect(killCalls).toEqual([]);
  });

  test("invokes local CLI/API kills, captures log output, and routes writer output directly", async () => {
    await expect(killHandler(makeCtx("cli", ["mawjs:1", "--pane", "2"]))).resolves.toEqual({
      ok: true,
      output: "killed mawjs:1 pane 2",
    });
    expect(killCalls.at(-1)).toEqual({ target: "mawjs:1", opts: { pane: 2 } });

    await expect(killHandler(makeCtx("api", { target: "tile", pane: 1 }))).resolves.toEqual({
      ok: true,
      output: "killed tile pane 1",
    });
    expect(killCalls.at(-1)).toEqual({ target: "tile", opts: { pane: 1 } });

    await expect(killHandler(makeCtx("api", {}))).resolves.toEqual({
      ok: false,
      error: "target is required",
    });

    const writerCalls: string[] = [];
    await expect(killHandler(makeCtx("api", { target: "writer-target" }, (...args: any[]) => {
      writerCalls.push(args.map(String).join(" "));
    }))).resolves.toEqual({ ok: true, output: undefined });
    expect(writerCalls).toEqual(["killed writer-target"]);

    await expect(killHandler(makeCtx("api", { target: "stderr" }))).resolves.toEqual({
      ok: true,
      output: "stderr kill log",
    });

    writerCalls.length = 0;
    await expect(killHandler(makeCtx("api", { target: "stderr" }, (...args: any[]) => {
      writerCalls.push(args.map(String).join(" "));
    }))).resolves.toEqual({ ok: true, output: undefined });
    expect(writerCalls).toEqual(["stderr kill log"]);
  });

  test("returns thrown kill errors when no command output was captured", async () => {
    killError = new Error("boom");

    await expect(killHandler(makeCtx("api", { target: "bad" }))).resolves.toEqual({
      ok: false,
      error: "boom",
      output: undefined,
    });
  });

  test("forwards CLI --peer kills and maps peer resolution/network/HTTP branches", async () => {
    await expect(killHandler(makeCtx("cli", ["target", "--peer", "missing"]))).resolves.toEqual({
      ok: false,
      error: "unknown peer alias: missing (see: maw peers list)",
    });

    peersByAlias.set("neo", { url: "http://neo", node: "neo-node" });
    peerKillError = new Error("connection reset");
    await expect(killHandler(makeCtx("cli", ["target", "--peer", "neo"]))).resolves.toEqual({
      ok: false,
      error: "peer kill failed (neo http://neo): connection reset",
    });

    peerKillError = null;
    peerKillResult = { ok: false, status: 404, data: {} };
    await expect(killHandler(makeCtx("cli", ["target", "--peer", "neo"]))).resolves.toEqual({
      ok: false,
      error: "peer neo does not support /api/kill (HTTP 404 at http://neo)",
    });

    peerKillResult = { ok: false, status: 503, data: { error: "maintenance" } };
    await expect(killHandler(makeCtx("cli", ["target", "--peer", "neo"]))).resolves.toEqual({
      ok: false,
      error: "peer kill failed (neo http://neo): maintenance",
    });

    peerKillResult = { ok: true, data: { output: "remote log" } };
    await expect(killHandler(makeCtx("cli", ["target", "--pane", "3", "--peer", "neo"]))).resolves.toEqual({
      ok: true,
      output: "\x1b[32m✓\x1b[0m forwarded kill → neo (http://neo) — target\nremote log",
    });
    expect(peerKillCalls.at(-1)).toEqual({ url: "http://neo", body: { target: "target", pane: 3 } });

    peerKillResult = { ok: true, data: {} };
    await expect(killHandler(makeCtx("cli", ["target", "--peer", "neo"]))).resolves.toEqual({
      ok: true,
      output: "\x1b[32m✓\x1b[0m forwarded kill → neo (http://neo) — target",
    });
  });
});
