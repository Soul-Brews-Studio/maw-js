/**
 * comm-peek.ts — default-suite coverage through explicit DI.
 */
import { describe, expect, test } from "bun:test";
import type { MawConfig } from "../src/config";
import type { SshSession as Session } from "../src/sdk";
import {
  cmdPeek,
  cmdPeekDeps,
  resolveSearchSessions,
  resolveSearchSessionsDeps,
  type CmdPeekDeps,
} from "../src/commands/shared/comm-peek";

interface HarnessOptions {
  config?: Partial<MawConfig>;
  sessions?: Session[];
  capture?: Record<string, string | Error>;
  findWindow?: string | null;
  fleet?: Record<string, string | null>;
  curl?: Record<string, { ok: boolean; data?: any; status?: number }>;
  shouldWake?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const captureCalls: Array<{ target: string; lines?: number }> = [];
  const findCalls: Array<{ sessions: Session[]; query: string }> = [];
  const curlCalls: string[] = [];
  const fleetCalls: string[] = [];
  const config = options.config ?? {};
  const sessions = options.sessions ?? [];

  const deps = cmdPeekDeps({
    loadConfig: () => config as MawConfig,
    resolveFleetSession: (name: string) => {
      fleetCalls.push(name);
      return options.fleet && name in options.fleet ? options.fleet[name]! : null;
    },
    listSessions: async () => sessions,
    capture: async (target: string, lines?: number) => {
      captureCalls.push({ target, lines });
      const value = options.capture?.[target];
      if (value instanceof Error) throw value;
      return value ?? "";
    },
    findWindow: (search: Session[], query: string) => {
      findCalls.push({ sessions: search, query });
      return options.findWindow ?? null;
    },
    curlFetch: async (url: string) => {
      curlCalls.push(url);
      return options.curl?.[url] ?? { ok: false, status: 0, data: null };
    },
    shouldAutoWake: (query: string) => ({
      wake: options.shouldWake ?? false,
      reason: `test-decision:${query}`,
    }),
    log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
    error: (...args: unknown[]) => { errors.push(args.map(String).join(" ")); },
    exit: (code = 0): never => {
      exits.push(code);
      throw new Error(`__exit__:${code}`);
    },
  });

  async function run(query?: string) {
    try {
      await cmdPeek(query, deps);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.startsWith("__exit__")) throw e;
    }
  }

  return { deps, logs, errors, exits, captureCalls, findCalls, curlCalls, fleetCalls, run };
}

const session = (name: string, windows: Array<{ index: number; name: string; active?: boolean }>): Session => ({
  name,
  windows: windows.map((w) => ({ index: w.index, name: w.name, active: !!w.active })),
});

const joined = (rows: string[]) => rows.join("\n");

describe("comm peek dependency factories", () => {
  test("resolveSearchSessionsDeps and cmdPeekDeps expose overridable defaults", () => {
    const loadConfig = () => ({ sessions: {} }) as MawConfig;
    const resolveFleetSession = () => null;
    const resolveDeps = resolveSearchSessionsDeps({ loadConfig, resolveFleetSession });
    const peekDeps = cmdPeekDeps({ loadConfig, resolveFleetSession });

    expect(resolveDeps.loadConfig).toBe(loadConfig);
    expect(resolveDeps.resolveFleetSession).toBe(resolveFleetSession);
    expect(peekDeps.loadConfig).toBe(loadConfig);
    expect(peekDeps.resolveFleetSession).toBe(resolveFleetSession);
    expect(typeof peekDeps.listSessions).toBe("function");
    expect(typeof peekDeps.capture).toBe("function");
    expect(typeof peekDeps.findWindow).toBe("function");
    expect(typeof peekDeps.curlFetch).toBe("function");
    expect(typeof peekDeps.shouldAutoWake).toBe("function");
    expect(typeof peekDeps.log).toBe("function");
    expect(typeof peekDeps.error).toBe("function");
    expect(typeof peekDeps.exit).toBe("function");
  });

  test("default console and exit delegates are callable", () => {
    const deps = cmdPeekDeps();
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;
    const logs: string[] = [];
    const errors: string[] = [];
    let code: number | undefined;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    (process as unknown as { exit: (code?: number) => never }).exit = (c = 0): never => {
      code = c;
      throw new Error(`__exit__:${c}`);
    };
    try {
      deps.log("log", "line");
      deps.error("err", "line");
      expect(() => deps.exit(9)).toThrow("__exit__:9");
    } finally {
      console.log = origLog;
      console.error = origErr;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }
    expect(logs).toEqual(["log line"]);
    expect(errors).toEqual(["err line"]);
    expect(code).toBe(9);
  });
});

describe("resolveSearchSessions", () => {
  const sessions = [
    session("05-neo", [{ index: 0, name: "neo-oracle" }]),
    session("08-mawjs", [{ index: 0, name: "mawjs-oracle" }]),
  ];

  test("prefers config.sessions mapping, then fleet mapping, then all sessions", () => {
    expect(resolveSearchSessions("mawjs", sessions, {
      loadConfig: () => ({ sessions: { mawjs: "08-mawjs" } }) as MawConfig,
      resolveFleetSession: () => "05-neo",
    }).map((s) => s.name)).toEqual(["08-mawjs"]);

    expect(resolveSearchSessions("mawjs", sessions, {
      loadConfig: () => ({ sessions: { mawjs: "missing" } }) as MawConfig,
      resolveFleetSession: () => "05-neo",
    }).map((s) => s.name)).toEqual(["05-neo"]);

    expect(resolveSearchSessions("mawjs", sessions, {
      loadConfig: () => ({}) as MawConfig,
      resolveFleetSession: () => null,
    })).toBe(sessions);
  });
});

describe("cmdPeek", () => {
  test("bare-name tip, slash normalization, and missing window error are visible", async () => {
    const previousQuiet = process.env.MAW_QUIET;
    delete process.env.MAW_QUIET;
    const h = makeHarness({ config: { node: "m5", sessions: {} } });
    try {
      await h.run("mawjs/");
    } finally {
      if (previousQuiet === undefined) delete process.env.MAW_QUIET;
      else process.env.MAW_QUIET = previousQuiet;
    }

    expect(h.exits).toEqual([1]);
    expect(joined(h.errors)).toContain("maw peek m5:mawjs");
    expect(joined(h.errors)).toContain("window not found: mawjs");
    expect(h.findCalls[0].query).toBe("mawjs");
  });

  test("quiet mode suppresses bare-name tip", async () => {
    const previousQuiet = process.env.MAW_QUIET;
    process.env.MAW_QUIET = "1";
    const h = makeHarness({ config: { node: "m5", sessions: {} } });
    try {
      await h.run("mawjs");
    } finally {
      if (previousQuiet === undefined) delete process.env.MAW_QUIET;
      else process.env.MAW_QUIET = previousQuiet;
    }
    expect(joined(h.errors)).not.toContain("tip");
  });

  test("remote namedPeer capture prints content and skips local session search", async () => {
    const url = "https://white.example/api/capture?target=mawjs";
    const h = makeHarness({
      config: { node: "m5", namedPeers: [{ name: "white", url: "https://white.example" }] },
      curl: { [url]: { ok: true, status: 200, data: { content: "remote body" } } },
    });

    await h.run("white:mawjs");

    expect(h.curlCalls).toEqual([url]);
    expect(h.findCalls).toEqual([]);
    expect(joined(h.logs)).toContain("white:mawjs");
    expect(joined(h.logs)).toContain("remote body");
  });

  test("remote peers[] fallback encodes target and failed capture exits 1", async () => {
    const h = makeHarness({
      config: { node: "m5", peers: ["https://white.example:3456"] },
      curl: {
        "https://white.example:3456/api/capture?target=name%20with%20space": {
          ok: false,
          status: 500,
          data: { error: "peer down" },
        },
      },
    });

    await h.run("white:name with space");

    expect(h.curlCalls).toEqual(["https://white.example:3456/api/capture?target=name%20with%20space"]);
    expect(h.exits).toEqual([1]);
    expect(joined(h.errors)).toContain("peer down");
  });

  test("local and local-node prefixes strip before local lookup", async () => {
    const h = makeHarness({
      config: { node: "m5", sessions: {} },
      sessions: [session("54-mawjs", [{ index: 0, name: "mawjs-oracle", active: true }])],
      findWindow: "54-mawjs:0",
      capture: { "54-mawjs:0": "local body" },
    });

    await h.run("local:mawjs");

    expect(h.curlCalls).toEqual([]);
    expect(h.findCalls[0].query).toBe("mawjs");
    expect(joined(h.logs)).toContain("local body");
  });

  test("unknown remote node falls through to local miss with original query", async () => {
    const h = makeHarness({
      config: { node: "m5", namedPeers: [{ name: "other", url: "https://other.example" }], sessions: {} },
      sessions: [session("54-mawjs", [{ index: 0, name: "mawjs-oracle" }])],
    });

    await h.run("ghost:mawjs");

    expect(h.curlCalls).toEqual([]);
    expect(h.findCalls[0].query).toBe("ghost:mawjs");
    expect(h.exits).toEqual([1]);
  });

  test("no-query overview prints last non-empty lines, empty fallback, and unreachable rows", async () => {
    const h = makeHarness({
      config: { sessions: {} },
      sessions: [session("54-mawjs", [
        { index: 0, name: "active-win", active: true },
        { index: 1, name: "blank-win" },
        { index: 2, name: "dead-win" },
      ])],
      capture: {
        "54-mawjs:0": "prompt\nlast line",
        "54-mawjs:1": "\n  \n",
        "54-mawjs:2": new Error("tmux refused"),
      },
    });

    await h.run();

    expect(h.captureCalls).toEqual([
      { target: "54-mawjs:0", lines: 3 },
      { target: "54-mawjs:1", lines: 3 },
      { target: "54-mawjs:2", lines: 3 },
    ]);
    const out = joined(h.logs);
    expect(out).toContain("active-win");
    expect(out).toContain("last line");
    expect(out).toContain("blank-win");
    expect(out).toContain("(empty)");
    expect(out).toContain("dead-win");
    expect(out).toContain("(unreachable)");
  });

  test("single-target local peek narrows mapped session and prints captured content", async () => {
    const h = makeHarness({
      config: { sessions: { mawjs: "54-mawjs" } },
      sessions: [
        session("33-other", [{ index: 0, name: "other" }]),
        session("54-mawjs", [{ index: 0, name: "mawjs-oracle" }]),
      ],
      findWindow: "54-mawjs:0",
      capture: { "54-mawjs:0": "pane body" },
    });

    await h.run("mawjs");

    expect(h.findCalls[0].sessions.map((s) => s.name)).toEqual(["54-mawjs"]);
    expect(h.captureCalls).toEqual([{ target: "54-mawjs:0", lines: undefined }]);
    expect(joined(h.logs)).toContain("--- 54-mawjs:0 ---");
    expect(joined(h.logs)).toContain("pane body");
  });

  test("defensive auto-wake warning branch stays non-waking", async () => {
    const h = makeHarness({
      config: { sessions: {} },
      shouldWake: true,
    });

    await h.run("mawjs");

    expect(joined(h.errors)).toContain("peek refuses");
    expect(h.exits).toEqual([1]);
  });
});
