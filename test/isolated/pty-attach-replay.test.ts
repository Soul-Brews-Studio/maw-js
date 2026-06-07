import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: unknown) => data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);

mock.module("../../src/config", () => ({
  loadConfig: () => ({ host: "local" }),
  cfgTimeout: () => 5,
  cfgLimit: (key: string) => key === "ptyRows" ? 80 : 200,
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmuxCmd: () => "tmux",
  tmux: {
    newGroupedSession: async () => {},
    setOption: async () => {},
    killSession: async () => {},
  },
}));

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

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
let spawnCalls: unknown[][] = [];
let spawnSyncImpl: (args: string[]) => { stdout: Uint8Array } = () => ({ stdout: encode("captured-pane") });

function installSpawnMocks() {
  spawnCalls = [];
  (Bun as any).spawnSync = (args: string[]) => spawnSyncImpl(args);
  (Bun as any).spawn = (args: unknown[]) => {
    spawnCalls.push(args);
    return {
      stdin: { write() {}, flush() {} },
      stdout: { getReader: () => ({ read: () => new Promise<never>(() => {}) }) },
      kill() {},
    };
  };
}

async function eventually(predicate: () => boolean, label: string) {
  const start = Date.now();
  while (Date.now() - start < 200) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => installSpawnMocks());
afterAll(() => {
  (Bun as any).spawn = originalSpawn;
  (Bun as any).spawnSync = originalSpawnSync;
});

describe("PTY attach scrollback replay (#1588)", async () => {
  const { handlePtyMessage } = await import("../../src/core/transport/pty.ts?pty-attach-replay");

  async function createCachedSession(target: string) {
    const ws = makeWs();
    spawnSyncImpl = () => ({ stdout: encode(`initial:${target}`) });
    const initialSpawnCount = spawnCalls.length;
    handlePtyMessage(ws as any, JSON.stringify({ type: "attach", target, cols: 100, rows: 40 }));
    await eventually(() => spawnCalls.length > initialSpawnCount, `initial spawn for ${target}`);
    return ws;
  }

  test("cached attach replays captured pane bytes before attached control message", async () => {
    const target = "replay-cache:0";
    await createCachedSession(target);

    spawnSyncImpl = (args) => {
      expect(args).toEqual(["tmux", "capture-pane", "-t", target, "-p", "-e", "-J", "-S", "-2000"]);
      return { stdout: encode("cached screen") };
    };

    const lateViewer = makeWs();
    handlePtyMessage(lateViewer as any, JSON.stringify({ type: "attach", target }));

    expect(lateViewer.sent.map(decode)).toEqual([
      "cached screen",
      "\r\n",
      JSON.stringify({ type: "attached", target }),
    ]);
  });

  test("fresh attach sends capture-pane bytes before spawning the live PTY", async () => {
    const target = "replay-fresh:0";
    const sequence: string[] = [];
    spawnCalls = [];
    spawnSyncImpl = () => {
      sequence.push("capture");
      return { stdout: encode("fresh screen") };
    };
    (Bun as any).spawn = (args: unknown[]) => {
      sequence.push(`spawn:${JSON.stringify(args)}`);
      spawnCalls.push(args);
      return {
        stdin: { write() {}, flush() {} },
        stdout: { getReader: () => ({ read: () => new Promise<never>(() => {}) }) },
        kill() {},
      };
    };

    const viewer = makeWs();
    const originalSend = viewer.send.bind(viewer);
    viewer.send = (data: unknown) => {
      sequence.push(`send:${decode(data)}`);
      originalSend(data);
    };

    handlePtyMessage(viewer as any, JSON.stringify({ type: "attach", target, cols: 100, rows: 40 }));
    await eventually(() => spawnCalls.length === 1, `fresh spawn for ${target}`);

    expect(sequence.slice(0, 4)).toEqual([
      "capture",
      "send:fresh screen",
      "send:\r\n",
      expect.stringContaining("spawn:"),
    ]);
  });

  test("capture-pane failure does not abort cached attach", async () => {
    const target = "replay-fail:0";
    await createCachedSession(target);

    spawnSyncImpl = () => { throw new Error("tmux target disappeared"); };
    const lateViewer = makeWs();
    handlePtyMessage(lateViewer as any, JSON.stringify({ type: "attach", target }));

    expect(lateViewer.sent.map(decode)).toEqual([
      JSON.stringify({ type: "attached", target }),
    ]);
  });
});
