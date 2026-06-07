/**
 * Runtime coverage for the PTY websocket bridge without opening real tmux,
 * ssh, script, or expect processes. Bun.spawn is process-global, so this lives
 * in test/isolated/ where CI runs one Bun process per file.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realConfig = await import("../../src/config");
const realTmux = await import("../../src/core/transport/tmux");

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

let mockActive = false;
let config: any;
let timeout = 10;
let colsLimit = 200;
let rowsLimit = 80;
let spawnPlans: SpawnPlan[] = [];
let spawnCalls: Array<{ args: string[]; opts: any }> = [];
let spawnSyncCalls: string[][] = [];
let spawnSyncImpl: (args: string[]) => { stdout?: Uint8Array } = () => ({ stdout: encode("scrollback") });
let readers: ControlledReader[] = [];
let stdinWrites: Uint8Array[] = [];
let procKills = 0;
let groupedCalls: Array<{ sessionName: string; ptySessionName: string; opts: any }> = [];
let groupedImpl: (sessionName: string, ptySessionName: string, opts: any) => Promise<void> = async () => {};
let setOptionCalls: Array<{ session: string; option: string; value: string }> = [];
let setOptionImpl: (session: string, option: string, value: string) => Promise<void> = async () => {};
let killSessionCalls: string[] = [];

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
const originalHost = process.env.MAW_HOST;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

mock.module(import.meta.resolve("../../src/config"), () => ({
  ...realConfig,
  loadConfig: () => (mockActive ? config : realConfig.loadConfig()),
  cfgTimeout: (key: Parameters<typeof realConfig.cfgTimeout>[0]) => (
    mockActive && key === "pty" ? timeout : realConfig.cfgTimeout(key)
  ),
  cfgLimit: (key: Parameters<typeof realConfig.cfgLimit>[0]) => {
    if (!mockActive) return realConfig.cfgLimit(key);
    if (key === "ptyCols") return colsLimit;
    if (key === "ptyRows") return rowsLimit;
    return realConfig.cfgLimit(key);
  },
}));

mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  ...realTmux,
  tmuxCmd: () => (mockActive ? "tmux-mock" : realTmux.tmuxCmd()),
  tmux: {
    ...realTmux.tmux,
    newGroupedSession: async (sessionName: string, ptySessionName: string, opts: any) => {
      if (!mockActive) return realTmux.tmux.newGroupedSession(sessionName, ptySessionName, opts);
      groupedCalls.push({ sessionName, ptySessionName, opts });
      return groupedImpl(sessionName, ptySessionName, opts);
    },
    setOption: async (session: string, option: string, value: string) => {
      if (!mockActive) return realTmux.tmux.setOption(session, option, value);
      setOptionCalls.push({ session, option, value });
      return setOptionImpl(session, option, value);
    },
    killSession: async (session: string) => {
      if (!mockActive) return realTmux.tmux.killSession(session);
      killSessionCalls.push(session);
    },
  },
}));

const { handlePtyClose, handlePtyMessage } = await import("../../src/core/transport/pty.ts?pty-transport-coverage");

function makeWs(): MockWs {
  return {
    sent: [],
    send(data: unknown) { this.sent.push(data); },
  };
}

function installSpawnMocks() {
  (Bun as any).spawnSync = (args: string[]) => {
    spawnSyncCalls.push(args);
    return spawnSyncImpl(args);
  };
  (Bun as any).spawn = (args: string[], opts: any) => {
    spawnCalls.push({ args, opts });
    const plan = spawnPlans.shift() ?? { autoEnd: true };
    const reader = new ControlledReader(plan.chunks ?? [], plan.autoEnd ?? true);
    readers.push(reader);
    return {
      stdin: {
        write(data: Uint8Array) { stdinWrites.push(data); },
        flush() { /* observed through successful call */ },
      },
      stdout: { getReader: () => reader },
      kill() {
        procKills += 1;
        if (plan.killThrows) throw new Error("already gone");
      },
    };
  };
}

async function finishReaders() {
  for (const reader of readers) reader.finish();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function eventually(predicate: () => boolean, label: string) {
  const start = Date.now();
  while (Date.now() - start < 250) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  mockActive = true;
  config = { host: "local" };
  timeout = 10;
  colsLimit = 200;
  rowsLimit = 80;
  spawnPlans = [];
  spawnCalls = [];
  spawnSyncCalls = [];
  spawnSyncImpl = () => ({ stdout: encode("scrollback") });
  readers = [];
  stdinWrites = [];
  procKills = 0;
  groupedCalls = [];
  groupedImpl = async () => {};
  setOptionCalls = [];
  setOptionImpl = async () => {};
  killSessionCalls = [];
  if (originalHost === undefined) delete process.env.MAW_HOST;
  else process.env.MAW_HOST = originalHost;
  installSpawnMocks();
});

afterEach(async () => {
  await finishReaders();
  (Bun as any).spawn = originalSpawn;
  (Bun as any).spawnSync = originalSpawnSync;
  if (originalHost === undefined) delete process.env.MAW_HOST;
  else process.env.MAW_HOST = originalHost;
  if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor);
  mockActive = false;
});

describe("PTY websocket bridge", () => {
  test("ignores malformed controls, empty sanitized targets, resize, detach, and binary input without a session", () => {
    const ws = makeWs();

    handlePtyMessage(ws as any, Buffer.from("typed-before-attach"));
    handlePtyMessage(ws as any, "not json");
    handlePtyMessage(ws as any, JSON.stringify({ type: "resize", cols: 10, rows: 5 }));
    handlePtyMessage(ws as any, JSON.stringify({ type: "detach" }));
    handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "!!!" }));

    expect(ws.sent).toEqual([]);
    expect(spawnCalls).toEqual([]);
    expect(groupedCalls).toEqual([]);
  });

  test("creates a local grouped PTY, clamps dimensions, replays capture, streams data, and cleans up on EOF", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const ws = makeWs();
    spawnPlans = [{ chunks: ["live bytes"], autoEnd: true }];

    handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "demo:oracle", cols: 999, rows: 0.4 }));
    await eventually(() => ws.sent.map(decode).includes(JSON.stringify({ type: "detached", target: "demo:oracle" })), "detached after EOF");

    expect(groupedCalls[0]).toMatchObject({
      sessionName: "demo",
      opts: { cols: 200, rows: 1, window: "oracle" },
    });
    expect(setOptionCalls[0]).toMatchObject({ option: "status", value: "off" });
    expect(spawnSyncCalls[0]).toEqual(["tmux", "capture-pane", "-t", "demo:oracle", "-p", "-e", "-J", "-S", "-2000"]);
    expect(ws.sent.map(decode)).toEqual([
      "scrollback",
      "\r\n",
      JSON.stringify({ type: "attached", target: "demo:oracle" }),
      "live bytes",
      JSON.stringify({ type: "detached", target: "demo:oracle" }),
    ]);
    expect(spawnCalls[0].args[0]).toBe("/usr/bin/expect");
    expect(spawnCalls[0].opts).toMatchObject({ stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
    expect(spawnCalls[0].opts.env.TERM).toBe("xterm-256color");
    expect(killSessionCalls).toContain(groupedCalls[0].ptySessionName);
  });

  test("reuses cached PTY sessions, cancels pending cleanup, replays capture, forwards keystrokes, and timer-cleans empty sessions", async () => {
    const first = makeWs();
    spawnPlans = [{ chunks: ["initial output"], autoEnd: false, killThrows: true }];

    handlePtyMessage(first as any, JSON.stringify({ type: "attach", target: "cached:main" }));
    await eventually(() => first.sent.map(decode).includes("initial output"), "initial PTY output");

    handlePtyMessage(first as any, Buffer.from("abc"));
    expect(stdinWrites.map(decode)).toEqual(["abc"]);

    handlePtyMessage(first as any, JSON.stringify({ type: "detach" }));
    spawnSyncImpl = () => ({ stdout: encode("cached screen") });
    const late = makeWs();
    handlePtyMessage(late as any, JSON.stringify({ type: "attach", target: "cached:main" }));

    expect(late.sent.map(decode)).toEqual([
      "cached screen",
      "\r\n",
      JSON.stringify({ type: "attached", target: "cached:main" }),
    ]);

    handlePtyClose(late as any);
    await eventually(() => procKills === 1, "cleanup timer kill");
    expect(killSessionCalls.length).toBeGreaterThanOrEqual(1);
    await finishReaders();
  });

  test("uses remote ssh hosts and tolerates capture plus status-option failures", async () => {
    config = { host: "remote.example" };
    setOptionImpl = async () => { throw new Error("option unsupported"); };
    spawnSyncImpl = () => { throw new Error("capture failed"); };
    spawnPlans = [{ autoEnd: true }];
    const ws = makeWs();

    handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "remote!bad:win", cols: 33, rows: 22 }));
    await eventually(() => spawnCalls.length === 1, "remote spawn");

    expect(groupedCalls[0]).toMatchObject({
      sessionName: "remotebad",
      opts: { cols: 33, rows: 22, window: "win" },
    });
    expect(spawnCalls[0].args[0]).toBe("ssh");
    expect(spawnCalls[0].args[1]).toBe("-tt");
    expect(spawnCalls[0].args[2]).toBe("remote.example");
    expect(spawnCalls[0].args[3]).toContain("tmux-mock attach-session");
    expect(ws.sent.map(decode)).toContain(JSON.stringify({ type: "detached", target: "remotebad:win" }));
  });

  test("uses script on non-darwin local hosts", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    spawnPlans = [{ autoEnd: true }];
    const ws = makeWs();

    handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target: "linux:main", cols: 70, rows: 20 }));
    await eventually(() => spawnCalls.length === 1, "local linux spawn");
    await finishReaders();

    expect(spawnCalls[0].args).toEqual([
      "script",
      "-qfc",
      expect.stringContaining("TERM=xterm-256color tmux-mock attach-session"),
      "/dev/null",
    ]);
  });

  test("fails closed on grouped-session creation errors and suppresses duplicate concurrent attaches", async () => {
    const blocked = makeWs();
    let release!: () => void;
    groupedImpl = () => new Promise<void>((resolve) => { release = resolve; });

    handlePtyMessage(blocked as any, JSON.stringify({ type: "attach", target: "same:win" }));
    handlePtyMessage(makeWs() as any, JSON.stringify({ type: "attach", target: "same:win" }));
    expect(groupedCalls).toHaveLength(1);
    release();
    await eventually(() => spawnCalls.length === 1, "first attach completes");
    await finishReaders();

    groupedImpl = async () => { throw new Error("no tmux"); };
    const failed = makeWs();
    handlePtyMessage(failed as any, JSON.stringify({ type: "attach", target: "fails" }));
    await eventually(() => failed.sent.length === 1, "grouped session failure");
    expect(failed.sent.map(decode)).toEqual([
      JSON.stringify({ type: "error", message: "Failed to create PTY session" }),
    ]);
  });
});
