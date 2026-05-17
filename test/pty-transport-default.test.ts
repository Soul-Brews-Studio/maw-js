/**
 * pty.ts — default-suite coverage for the websocket PTY bridge using injected
 * process/tmux/config seams instead of global Bun/tmux mocks.
 */
import { describe, expect, test } from "bun:test";
import { createPtyHandlers, ptyDeps, type PtyDeps } from "../src/core/transport/pty";

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
  test("ignores malformed controls, empty sanitized targets, resize/detach, and binary before attach", () => {
    const h = makeHarness();
    const ws = makeWs();

    h.handlePtyMessage(ws as any, Buffer.from("typed-before-attach"));
    h.handlePtyMessage(ws as any, "not json");
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "resize", cols: 10, rows: 5 }));
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "detach" }));
    h.handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "!!!" }));

    expect(ws.sent).toEqual([]);
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
});
