/**
 * pty.ts — default-suite coverage for the websocket PTY bridge using injected
 * process/tmux/config seams instead of global Bun/tmux mocks.
 */
import { describe, expect, test } from "bun:test";
import { controlTarget, createPtyHandlers, ptyDeps, type PtyDeps } from "../src/core/transport/pty";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: unknown) => data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);

type ReadResult = { done: boolean; value?: Uint8Array };
type SpawnPlan = { chunks?: string[]; autoEnd?: boolean; killThrows?: boolean };

class ControlledReader {
  private chunks: Uint8Array[];
  private ended = false;
  private pending: Array<(value: ReadResult) => void> = [];

  constructor(chunks: string[], private readonly autoEnd: boolean) {
    this.chunks = chunks.map(encode);
  }

  read(): Promise<ReadResult> {
    if (this.chunks.length > 0) return Promise.resolve({ done: false, value: this.chunks.shift() });
    if (this.autoEnd || this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.pending.push(resolve));
  }

  finish() {
    this.ended = true;
    for (const resolve of this.pending.splice(0)) resolve({ done: true });
  }
}

interface MockWs {
  sent: unknown[];
  send(data: unknown): void;
}

function makeWs(): MockWs {
  return {
    sent: [],
    send(data: unknown) { this.sent.push(data); },
  };
}

function makeHarness(options: {
  host?: string;
  envHost?: string;
  platform?: NodeJS.Platform;
  timeout?: number;
  colsLimit?: number;
  rowsLimit?: number;
  spawnPlans?: SpawnPlan[];
  spawnSync?: (args: string[]) => { stdout?: Uint8Array };
  groupedImpl?: (sessionName: string, ptySessionName: string, opts: unknown) => Promise<void>;
  setOptionImpl?: (session: string, option: string, value: string) => Promise<void>;
  listSessionGroupsImpl?: () => Promise<Array<{ name: string; group: string }>>;
} = {}) {
  const spawnPlans = [...(options.spawnPlans ?? [])];
  const readers: ControlledReader[] = [];
  const stdinWrites: Uint8Array[] = [];
  const spawnCalls: Array<{ args: string[]; opts: any }> = [];
  const spawnSyncCalls: string[][] = [];
  const groupedCalls: Array<{ sessionName: string; ptySessionName: string; opts: any }> = [];
  const setOptionCalls: Array<{ session: string; option: string; value: string }> = [];
  const killSessionCalls: string[] = [];
  const timerCallbacks: Array<{ active: boolean; fn: () => void }> = [];
  const clearedTimers: unknown[] = [];
  let procKills = 0;

  const deps: Partial<PtyDeps> = {
    loadConfig: () => ({ host: options.host ?? "local" } as any),
    cfgTimeout: (key) => key === "pty" ? options.timeout ?? 10 : 0,
    cfgLimit: (key) => key === "ptyCols" ? options.colsLimit ?? 200 : options.rowsLimit ?? 80,
    tmuxCmd: () => "tmux-mock",
    env: () => options.envHost === undefined ? {} as NodeJS.ProcessEnv : { MAW_HOST: options.envHost } as NodeJS.ProcessEnv,
    platform: () => options.platform ?? "linux",
    now: () => 123456,
    spawnSync: (args: string[]) => {
      spawnSyncCalls.push(args);
      return (options.spawnSync ?? (() => ({ stdout: encode("scrollback") })))(args) as ReturnType<typeof Bun.spawnSync>;
    },
    spawn: (args: string[], opts: any) => {
      spawnCalls.push({ args, opts });
      const plan = spawnPlans.shift() ?? { autoEnd: true };
      const reader = new ControlledReader(plan.chunks ?? [], plan.autoEnd ?? true);
      readers.push(reader);
      return {
        stdin: {
          write(data: Uint8Array) { stdinWrites.push(data); },
          flush() { /* observed by write count */ },
        },
        stdout: { getReader: () => reader },
        kill() {
          procKills += 1;
          if (plan.killThrows) throw new Error("already gone");
        },
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
    tmux: {
      newGroupedSession: async (sessionName: string, ptySessionName: string, opts: any) => {
        groupedCalls.push({ sessionName, ptySessionName, opts });
        await options.groupedImpl?.(sessionName, ptySessionName, opts);
      },
      setOption: async (session: string, option: string, value: string) => {
        setOptionCalls.push({ session, option, value });
        await options.setOptionImpl?.(session, option, value);
      },
      killSession: async (session: string) => { killSessionCalls.push(session); },
      // Only present when the test opts in — mirrors production where the real
      // tmux always has it but injected mocks may omit it (sweep/#P3 no-op).
      ...(options.listSessionGroupsImpl ? { listSessionGroups: options.listSessionGroupsImpl } : {}),
    },
    setTimeout: ((fn: () => void, _ms?: number) => {
      const timer = { active: true, fn };
      timerCallbacks.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((timer: unknown) => {
      clearedTimers.push(timer);
      if (timer && typeof timer === "object" && "active" in timer) {
        (timer as { active: boolean }).active = false;
      }
    }) as typeof clearTimeout,
  };

  const handlers = createPtyHandlers(deps);
  const finishReaders = async () => {
    for (const reader of readers) reader.finish();
    await Promise.resolve();
    await Promise.resolve();
  };
  const runTimers = async () => {
    for (const timer of timerCallbacks.splice(0)) {
      if (timer.active) timer.fn();
    }
    await Promise.resolve();
  };

  return {
    ...handlers,
    readers,
    stdinWrites,
    spawnCalls,
    spawnSyncCalls,
    groupedCalls,
    setOptionCalls,
    killSessionCalls,
    timerCallbacks,
    clearedTimers,
    get procKills() { return procKills; },
    finishReaders,
    runTimers,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function eventually(predicate: () => boolean, label: string) {
  const start = Date.now();
  while (Date.now() - start < 250) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("ptyDeps", () => {
  test("exposes overridable production defaults", () => {
    const loadConfig = () => ({ host: "local" }) as any;
    const deps = ptyDeps({ loadConfig });

    expect(deps.loadConfig).toBe(loadConfig);
    expect(typeof deps.tmux.newGroupedSession).toBe("function");
    expect(typeof deps.tmux.setOption).toBe("function");
    expect(typeof deps.tmux.killSession).toBe("function");
    expect(typeof deps.tmuxCmd).toBe("function");
    expect(typeof deps.cfgTimeout).toBe("function");
    expect(typeof deps.cfgLimit).toBe("function");
    expect(typeof deps.spawn).toBe("function");
    expect(typeof deps.spawnSync).toBe("function");
    expect(typeof deps.env()).toBe("object");
    expect(typeof deps.platform()).toBe("string");
    expect(typeof deps.now()).toBe("number");
    expect(typeof deps.setTimeout).toBe("function");
    expect(typeof deps.clearTimeout).toBe("function");
  });
});

describe("createPtyHandlers", () => {
  test("ignores malformed controls, resize/detach, and binary before attach — but says so when a target sanitizes away", () => {
    const h = makeHarness();
    const ws = makeWs();

    h.handlePtyMessage(ws as any, Buffer.from("typed-before-attach"));
    h.handlePtyMessage(ws as any, "not json");
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "resize", cols: 10, rows: 5 }));
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "detach" }));

    // Everything above is genuinely nothing to report: a keystroke before any
    // attach, a frame that is not JSON, and two controls that did their job.
    expect(ws.sent).toEqual([]);

    // "!!!" is different — the client asked for something and got refused. It
    // used to be refused in silence, which reads identically to a pane that has
    // nothing to show, so the refusal now goes back down the socket.
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "!!!" }));
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string).type).toBe("error");

    expect(h.spawnCalls).toEqual([]);
    expect(h.groupedCalls).toEqual([]);
  });

  test("creates a darwin local grouped PTY, clamps dimensions, replays capture, streams output, and cleans up on EOF", async () => {
    const h = makeHarness({ platform: "darwin", colsLimit: 200, rowsLimit: 80, spawnPlans: [{ chunks: ["live bytes"], autoEnd: true }] });
    const ws = makeWs();

    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "demo:oracle", cols: 999, rows: 0.4 }));
    await eventually(() => ws.sent.map(decode).includes(JSON.stringify({ type: "detached", target: "demo:oracle" })), "darwin PTY detach");

    expect(h.groupedCalls[0]).toMatchObject({
      sessionName: "demo",
      ptySessionName: "maw-pty-123456-1",
      opts: { cols: 200, rows: 1, window: "oracle" },
    });
    expect(h.setOptionCalls[0]).toEqual({ session: "maw-pty-123456-1", option: "status", value: "off" });
    expect(h.spawnSyncCalls[0]).toEqual(["tmux", "capture-pane", "-t", "demo:oracle", "-p", "-e", "-J", "-S", "-2000"]);
    expect(h.spawnCalls[0].args[0]).toBe("/usr/bin/expect");
    expect(h.spawnCalls[0].opts).toMatchObject({ stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
    expect(h.spawnCalls[0].opts.env.TERM).toBe("xterm-256color");
    expect(ws.sent.map(decode)).toEqual([
      "scrollback",
      "\r\n",
      JSON.stringify({ type: "attached", target: "demo:oracle" }),
      "live bytes",
      JSON.stringify({ type: "detached", target: "demo:oracle" }),
    ]);
    expect(h.killSessionCalls).toContain("maw-pty-123456-1");
  });

  test("reuses cached sessions, cancels cleanup, replays capture, forwards keystrokes, and timer-cleans empty sessions", async () => {
    const h = makeHarness({ spawnPlans: [{ chunks: ["initial output"], autoEnd: false, killThrows: true }] });
    const first = makeWs();

    h.handlePtyMessage(first as any, JSON.stringify({ type: "attach", target: "cached:main" }));
    await eventually(() => first.sent.map(decode).includes("initial output"), "initial cached PTY output");
    expect(first.sent.map(decode)).toContain("initial output");

    h.handlePtyMessage(first as any, Buffer.from("abc"));
    expect(h.stdinWrites.map(decode)).toEqual(["abc"]);

    h.handlePtyMessage(first as any, JSON.stringify({ type: "detach" }));
    expect(h.timerCallbacks).toHaveLength(1);

    const late = makeWs();
    h.handlePtyMessage(late as any, JSON.stringify({ type: "attach", target: "cached:main" }));
    expect(h.clearedTimers).toHaveLength(1);
    expect(late.sent.map(decode)).toEqual([
      "scrollback",
      "\r\n",
      JSON.stringify({ type: "attached", target: "cached:main" }),
    ]);

    h.handlePtyClose(late as any);
    await h.runTimers();
    expect(h.procKills).toBe(1);
    expect(h.killSessionCalls).toContain("maw-pty-123456-1");
    await h.finishReaders();
  });

  test("uses remote ssh hosts and tolerates capture plus status-option failures", async () => {
    const h = makeHarness({
      host: "remote.example",
      setOptionImpl: async () => { throw new Error("option unsupported"); },
      spawnSync: () => { throw new Error("capture failed"); },
      spawnPlans: [{ autoEnd: true }],
    });
    const ws = makeWs();

    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "remote!bad:win", cols: 33, rows: 22 }));
    await eventually(() => h.spawnCalls.length === 1, "remote PTY spawn");

    expect(h.groupedCalls[0]).toMatchObject({ sessionName: "remotebad", opts: { cols: 33, rows: 22, window: "win" } });
    expect(h.spawnCalls[0].args[0]).toBe("ssh");
    expect(h.spawnCalls[0].args[1]).toBe("-tt");
    expect(h.spawnCalls[0].args[2]).toBe("remote.example");
    expect(h.spawnCalls[0].args[3]).toContain("tmux-mock attach-session");
    expect(ws.sent.map(decode)).toContain(JSON.stringify({ type: "detached", target: "remotebad:win" }));
  });

  test("uses MAW_HOST over config host and script on non-darwin local hosts", async () => {
    const h = makeHarness({ host: "ignored.example", envHost: "localhost", platform: "linux", spawnPlans: [{ autoEnd: true }] });
    const ws = makeWs();

    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "linux:main", cols: 70, rows: 20 }));
    await eventually(() => h.spawnCalls.length === 1, "linux PTY spawn");

    expect(h.spawnCalls[0].args).toEqual([
      "script",
      "-qfc",
      expect.stringContaining("TERM=xterm-256color tmux-mock attach-session"),
      "/dev/null",
    ]);
  });

  test("fails closed on grouped-session creation errors and suppresses duplicate concurrent attaches", async () => {
    let release!: () => void;
    const h = makeHarness({ groupedImpl: () => new Promise<void>((resolve) => { release = resolve; }) });
    const blocked = makeWs();

    h.handlePtyMessage(blocked as any, JSON.stringify({ type: "attach", target: "same:win" }));
    h.handlePtyMessage(makeWs() as any, JSON.stringify({ type: "attach", target: "same:win" }));
    expect(h.groupedCalls).toHaveLength(1);
    release();
    await eventually(() => h.spawnCalls.length === 1, "blocked attach release");
    expect(h.spawnCalls).toHaveLength(1);
    await h.finishReaders();

    const failedHarness = makeHarness({ groupedImpl: async () => { throw new Error("no tmux"); } });
    const failed = makeWs();
    failedHarness.handlePtyMessage(failed as any, JSON.stringify({ type: "attach", target: "fails" }));
    await eventually(() => failed.sent.length === 1, "grouped-session failure");

    expect(failed.sent.map(decode)).toEqual([
      JSON.stringify({ type: "error", message: "Failed to create PTY session" }),
    ]);
  });

  test("fresh and cached capture failures do not abort attach", async () => {
    const h = makeHarness({ spawnSync: () => { throw new Error("tmux target disappeared"); }, spawnPlans: [{ chunks: ["first"], autoEnd: false }] });
    const first = makeWs();
    h.handlePtyMessage(first as any, JSON.stringify({ type: "attach", target: "capture-fail:0" }));
    await eventually(() => first.sent.map(decode).includes("first"), "capture failure fresh output");

    expect(first.sent.map(decode)).toEqual([
      JSON.stringify({ type: "attached", target: "capture-fail:0" }),
      "first",
    ]);

    const late = makeWs();
    h.handlePtyMessage(late as any, JSON.stringify({ type: "attach", target: "capture-fail:0" }));
    expect(late.sent.map(decode)).toEqual([
      JSON.stringify({ type: "attached", target: "capture-fail:0" }),
    ]);
    await h.finishReaders();
  });

  test("honors attach replayLines overrides for follow clients", async () => {
    const noReplay = makeHarness({ spawnPlans: [{ chunks: ["live"], autoEnd: true }] });
    const liveOnly = makeWs();
    noReplay.handlePtyMessage(liveOnly as any, JSON.stringify({ type: "attach", target: "follow:0", replayLines: 0 }));
    await eventually(() => liveOnly.sent.map(decode).includes(JSON.stringify({ type: "detached", target: "follow:0" })), "no-replay detach");

    expect(noReplay.spawnSyncCalls).toEqual([]);
    expect(liveOnly.sent.map(decode)).toEqual([
      JSON.stringify({ type: "attached", target: "follow:0" }),
      "live",
      JSON.stringify({ type: "detached", target: "follow:0" }),
    ]);

    const shared = makeHarness({ spawnPlans: [{ chunks: ["first"], autoEnd: false }] });
    const firstViewer = makeWs();
    shared.handlePtyMessage(firstViewer as any, JSON.stringify({ type: "attach", target: "follow:shared", replayLines: 0 }));
    await eventually(() => firstViewer.sent.map(decode).includes("first"), "shared follow output");
    expect(shared.spawnSyncCalls).toEqual([]);

    const secondViewer = makeWs();
    shared.handlePtyMessage(secondViewer as any, JSON.stringify({ type: "attach", target: "follow:shared", replayLines: 0 }));
    expect(shared.spawnSyncCalls).toEqual([]);
    expect(secondViewer.sent.map(decode)).toEqual([
      JSON.stringify({ type: "attached", target: "follow:shared" }),
    ]);
    await shared.finishReaders();

    const bounded = makeHarness({ spawnPlans: [{ autoEnd: true }] });
    const withReplay = makeWs();
    bounded.handlePtyMessage(withReplay as any, JSON.stringify({ type: "attach", target: "follow:1", replayLines: 12 }));
    await eventually(() => bounded.spawnCalls.length === 1, "bounded replay spawn");

    expect(bounded.spawnSyncCalls[0]).toEqual(["tmux", "capture-pane", "-t", "follow:1", "-p", "-e", "-J", "-S", "-12"]);
  });

  test("#P2 sweep kills untracked maw-pty-* sessions, sparing tracked and non-maw sessions", async () => {
    const groups = [
      { name: "01-labubu", group: "01-labubu" },        // parent — not maw-pty
      { name: "maw-pty-orphan-1", group: "01-labubu" },  // orphan
      { name: "maw-pty-orphan-2", group: "" },           // ungrouped orphan
      { name: "some-view", group: "" },                  // not maw-pty
    ];
    const h = makeHarness({ listSessionGroupsImpl: async () => groups, spawnPlans: [{ chunks: ["x"], autoEnd: false }] });

    // Attach so one maw-pty session becomes tracked in-memory.
    const ws = makeWs();
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "tracked:0" }));
    await eventually(() => h.groupedCalls.length === 1, "tracked attach");
    const trackedName = h.groupedCalls[0].ptySessionName;
    groups.push({ name: trackedName, group: "tracked" });

    const result = await h.sweepOrphanPtySessions();
    expect(result.killed.sort()).toEqual(["maw-pty-orphan-1", "maw-pty-orphan-2"]);
    expect(result.checked).toBe(5);
    expect(result.killed).not.toContain(trackedName);
    expect(h.killSessionCalls).toContain("maw-pty-orphan-1");
    expect(h.killSessionCalls).not.toContain(trackedName);
    await h.finishReaders();
  });

  test("#P2 sweep no-ops when tmux lacks listSessionGroups (injected mock)", async () => {
    const h = makeHarness(); // no listSessionGroupsImpl → method absent
    const result = await h.sweepOrphanPtySessions();
    expect(result).toEqual({ killed: [], checked: 0 });
    expect(h.killSessionCalls).toEqual([]);
  });

  test("#P3 attach kills a pre-existing untracked grouped orphan on the same parent only", async () => {
    const groups = [
      { name: "01-labubu", group: "01-labubu" },
      { name: "maw-pty-stale", group: "01-labubu" },  // same parent, untracked → kill
      { name: "maw-pty-other", group: "02-neo" },      // different parent → spare
    ];
    const h = makeHarness({ listSessionGroupsImpl: async () => groups, spawnPlans: [{ autoEnd: true }] });
    const ws = makeWs();

    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "01-labubu:0" }));
    // P3 is fire-and-forget alongside session creation — poll for the kill.
    await eventually(() => h.killSessionCalls.includes("maw-pty-stale"), "P3 stale-orphan kill");
    expect(h.killSessionCalls).not.toContain("maw-pty-other");
    await h.finishReaders();
  });
});

/**
 * Regression: on 2026-08-10 a single ws frame carrying `"target": null` reached
 * `target.replace` inside the *async* attach(), and the resulting unhandled
 * rejection killed the whole `maw serve` process — Colony went blind for the
 * entire fleet while every oracle underneath it kept running normally.
 *
 * The try/catch that already wrapped the dispatch could not help: attach() is
 * async, so it rejects rather than throws, and a rejection does not travel up
 * into a synchronous catch. These tests therefore assert two separate things —
 * that the frame is refused *and explained*, and that nothing about handling it
 * produces an unhandled rejection.
 */
describe("createPtyHandlers — a malformed attach must not kill the process", () => {
  const badTargets: Array<[string, unknown]> = [
    ["null", null],
    ["a number", 42],
    ["an object", { name: "01-labubu" }],
    ["an array", ["01-labubu"]],
    ["a boolean", true],
    ["the empty string", ""],
    ["whitespace only", "   "],
    ["missing entirely", undefined],
  ];

  for (const [label, target] of badTargets) {
    test(`refuses target = ${label} with an error the client can read, and keeps serving`, async () => {
      const h = makeHarness();
      const ws = makeWs();
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);

      try {
        h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target }));
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Refused...
        expect(h.spawnCalls).toEqual([]);
        expect(h.groupedCalls).toEqual([]);
        // ...out loud, so the client learns what it did wrong.
        expect(ws.sent).toHaveLength(1);
        const reply = JSON.parse(ws.sent[0] as string);
        expect(reply.type).toBe("error");
        expect(reply.message).toContain("target");
        // ...and without the rejection that took the process down.
        expect(rejections).toEqual([]);

        // Still serving: a good frame right after a bad one still attaches.
        h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "01-labubu:0" }));
        await eventually(() => h.spawnCalls.length === 1, "attach after a malformed frame");
        await h.finishReaders();
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    });
  }

  test("a rejection raised past attach()'s own try/catch never reaches the process", async () => {
    // Session creation already had an internal try/catch, so that path was never
    // the one that killed serve. The unguarded surface is everything *outside*
    // it — here, the bare `ws.send({type:"attached"})` on the cached-session
    // branch. A viewer that goes away between JOIN and that send makes send()
    // throw, and before the .catch() this rejected into the process exactly the
    // way `target.replace` on null did.
    const h = makeHarness({ spawnPlans: [{ autoEnd: false }] });
    const first = makeWs();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      h.handlePtyMessage(first as any, JSON.stringify({ type: "attach", target: "01-labubu:0" }));
      await eventually(() => h.spawnCalls.length === 1, "first attach creates the session");

      // Second viewer joins the cached session, then dies mid-send.
      const dying = {
        sent: [] as unknown[],
        send() { throw new Error("WebSocket is already closed"); },
      };
      h.handlePtyMessage(dying as any, JSON.stringify({ type: "attach", target: "01-labubu:0" }));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(rejections).toEqual([]);

      // And the server is still serving the viewer that is still there.
      h.handlePtyMessage(first as any, JSON.stringify({ type: "detach" }));
      await flush();
      expect(rejections).toEqual([]);
      await h.finishReaders();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("controlTarget accepts what a real client sends and nothing else", () => {
    expect(controlTarget("01-labubu:0")).toBe("01-labubu:0");
    expect(controlTarget("  01-labubu:0  ")).toBe("01-labubu:0");
    expect(controlTarget(null)).toBeNull();
    expect(controlTarget(undefined)).toBeNull();
    expect(controlTarget("")).toBeNull();
    expect(controlTarget("   ")).toBeNull();
    expect(controlTarget(42)).toBeNull();
    expect(controlTarget({})).toBeNull();
    expect(controlTarget([])).toBeNull();
  });
});
