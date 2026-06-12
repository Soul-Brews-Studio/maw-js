import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { serve, setShareWsDepsForTests } from "../src/vendor/mpr-plugins/share/index";
import { clearShareRegistry, createShare, type Share } from "../src/vendor/mpr-plugins/share/impl";
import { __resetShareStreamBusesForTests, __resolveShareStreamDepsForTests, attach, type ShareStreamHandle } from "../src/vendor/mpr-plugins/share/stream";

type WsMessage = string | Uint8Array;
type FakeWs = {
  send: (data: WsMessage) => void;
};

function makeFakeWs(): { ws: FakeWs; sent: Array<WsMessage> } {
  const sent: Array<WsMessage> = [];
  return {
    ws: {
      send: (data: WsMessage) => sent.push(data),
    },
    sent,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: WsMessage): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function frame(data: WsMessage): any {
  return JSON.parse(text(data));
}

describe("share readonly stream", () => {
  let killCalls: Array<Array<unknown>> = [];
  let pipeCalls: Array<Array<unknown>> = [];
  let captures: string[] = [];
  let sendKeysCalls: number = 0;

  let restoreShareWsDeps: (() => void) | null = null;

  beforeEach(() => {
    restoreShareWsDeps?.();
    restoreShareWsDeps = null;
    clearShareRegistry();
    __resetShareStreamBusesForTests();
    killCalls = [];
    pipeCalls = [];
    captures = [];
    sendKeysCalls = 0;
  });

  afterEach(() => {
    restoreShareWsDeps?.();
    restoreShareWsDeps = null;
    clearShareRegistry();
  });


  test("websocket close before attach resolves closes late stream handle", async () => {
    const share = await createShare({ target: "session:0", ttl: 60 });
    let resolveAttach: ((handle: ShareStreamHandle) => void) | null = null;
    let handleCloseCalls = 0;
    const lateHandle: ShareStreamHandle = {
      onMessage: () => undefined,
      close: async () => {
        handleCloseCalls += 1;
      },
    };

    restoreShareWsDeps = setShareWsDepsForTests({
      attach: async () => new Promise<ShareStreamHandle>((resolve) => {
        resolveAttach = resolve;
      }),
    });

    let handlers: {
      open: (ws: any) => void;
      message: (ws: any, message: unknown) => void;
      close: (ws: any) => void;
    } | null = null;

    await serve({
      http: {
        route: () => undefined,
      },
      ws: {
        route: (_path: string, _data: unknown, next: typeof handlers) => {
          handlers = next;
        },
      },
    } as any);

    const sent: string[] = [];
    const closes: Array<[number, string | undefined]> = [];
    const ws = {
      data: { params: { slug: share.slug }, shareSlug: share.slug, shareToken: share.token },
      send: (data: string) => sent.push(data),
      close: (code: number, reason?: string) => closes.push([code, reason]),
    };

    handlers!.open(ws);
    for (let i = 0; i < 10 && !resolveAttach; i += 1) await Promise.resolve();
    expect(resolveAttach).toBeFunction();
    handlers!.close(ws);

    resolveAttach!(lateHandle);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(handleCloseCalls).toBe(1);
    expect(closes).toEqual([]);

    handlers!.message(ws, "ping");
    expect(sent).toEqual([]);
  });

  test("default stream deps preserve real Tmux prototype methods", () => {
    const resolved = __resolveShareStreamDepsForTests();

    expect(typeof resolved.tmux.capture).toBe("function");
    expect(typeof resolved.tmux.pipePane).toBe("function");
  });

  test("dropping inbound ws messages does not write pane text", async () => {
    const share: Share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 1_000_000,
      auth: "token",
    };

    const { ws, sent } = makeFakeWs();
    let childResolve: (() => void) | null = null;
    const handle = await attach(
      share,
      ws as unknown as any,
      {
        tmux: {
          run: async () => "80 24",
          capture: async (target: string) => {
            captures.push(target);
            return "SNAPSHOT\n";
          },
          pipePane: async (...args: unknown[]) => {
            pipeCalls.push(args);
          },
          sendKeys: async () => {
            sendKeysCalls += 1;
          },
        },
        makeFifo: async () => undefined,
        spawnPipeReader: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
          onChunk(bytes("LIVE\n"));
          return {
            kill: (signal?: string | number) => {
              killCalls.push(["kill", signal]);
            },
            exited: new Promise((resolve) => {
              childResolve = resolve;
            }),
          };
        },
      } as any,
    );

    expect(sent.map(frame)).toEqual([
      { type: "maw-share-frame", pane: "session:0", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } },
      { type: "maw-share-frame", pane: "session:0", data: "LIVE\n" },
    ]);
    expect(captures).toEqual(["session:0"]);

    handle.onMessage("ping");
    handle.onMessage(bytes("typed-inbound"));
    handle.onMessage("typed-string");
    expect(sendKeysCalls).toBe(0);

    await handle.close();
    if (childResolve) childResolve();

    expect(pipeCalls.some((call) => call[0] === "session:0" && call.length === 1)).toBe(true);
    expect(killCalls.length).toBeGreaterThan(0);
  });

  test("reconnect attach sends a fresh snapshot before resuming live pipe", async () => {
    const share: Share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 1_000_000,
      auth: "token",
    };
    const sentA: Array<WsMessage> = [];
    const sentB: Array<WsMessage> = [];
    const localPipeCalls: Array<Array<unknown>> = [];
    const liveHandlers: Array<(chunk: Uint8Array) => void> = [];
    const childResolvers: Array<() => void> = [];
    const localKillCalls: Array<unknown> = [];
    let captureCount = 0;

    const deps = {
      tmux: {
        run: async () => "80 24",
        capture: async () => `SNAPSHOT-${++captureCount}\n`,
        pipePane: async (...args: unknown[]) => {
          localPipeCalls.push(args);
        },
      },
      makeFifo: async () => undefined,
      spawnPipeReader: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
        liveHandlers.push(onChunk);
        return {
          kill: (signal?: string | number) => { localKillCalls.push(signal); },
          exited: new Promise((resolve) => { childResolvers.push(() => resolve(0)); }),
        };
      },
    } as any;

    const first = await attach(share, { send: (data: WsMessage) => sentA.push(data) } as any, deps);
    liveHandlers[0]!(bytes("LIVE-OLD\n"));
    expect(sentA.map(frame)).toEqual([
      { type: "maw-share-frame", pane: "session:0", data: "SNAPSHOT-1\n", snapshot: true, dimensions: { cols: 80, rows: 24 } },
      { type: "maw-share-frame", pane: "session:0", data: "LIVE-OLD\n" },
    ]);

    childResolvers[0]?.();
    await first.close();

    const second = await attach(share, { send: (data: WsMessage) => sentB.push(data) } as any, deps);
    liveHandlers[1]!(bytes("LIVE-NEW\n"));
    expect(sentB.map(frame)).toEqual([
      { type: "maw-share-frame", pane: "session:0", data: "SNAPSHOT-2\n", snapshot: true, dimensions: { cols: 80, rows: 24 } },
      { type: "maw-share-frame", pane: "session:0", data: "LIVE-NEW\n" },
    ]);

    expect(captureCount).toBe(2);
    expect(liveHandlers).toHaveLength(2);
    expect(localPipeCalls.map((call) => call.length)).toEqual([3, 1, 3]);
    expect(localKillCalls).toContain("SIGTERM");

    childResolvers[1]?.();
    await second.close();
  });

  test("multi-pane share tags snapshots and live chunks per pane with independent pipe teardown", async () => {
    const share: Share = {
      target: "session:0",
      panes: ["session:0.0", "session:0.1"],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 1_000_000,
      auth: "token",
    };
    const sent: Array<WsMessage> = [];
    const localPipeCalls: Array<Array<unknown>> = [];
    const liveHandlers = new Map<string, (chunk: Uint8Array) => void>();
    const childResolvers = new Map<string, () => void>();
    const localKillCalls: Array<[string, unknown]> = [];

    const handle = await attach(share, { send: (data: WsMessage) => sent.push(data) } as any, {
      tmux: {
        run: async (_cmd: string, _flag: string, target: string) => target.includes("0.0") ? "106 51" : "90 40",
        capture: async (target: string) => `SNAPSHOT ${target}\n`,
        pipePane: async (...args: unknown[]) => { localPipeCalls.push(args); },
      },
      makeFifo: async () => undefined,
      spawnPipeReader: async (path: string, onChunk: (chunk: Uint8Array) => void) => {
        const target = path.includes("session-0.0") ? "session:0.0" : "session:0.1";
        liveHandlers.set(target, onChunk);
        return {
          kill: (signal?: string | number) => { localKillCalls.push([target, signal]); },
          exited: new Promise((resolve) => { childResolvers.set(target, () => resolve(0)); }),
        };
      },
      tmpdir: () => "/tmp",
      join: (...parts: string[]) => parts.join("/"),
    } as any);

    expect(sent.slice(0, 2).map(frame)).toEqual([
      { type: "maw-share-frame", pane: "session:0.0", data: "SNAPSHOT session:0.0\n", snapshot: true, dimensions: { cols: 106, rows: 51 } },
      { type: "maw-share-frame", pane: "session:0.1", data: "SNAPSHOT session:0.1\n", snapshot: true, dimensions: { cols: 90, rows: 40 } },
    ]);
    expect(localPipeCalls.filter((call) => call.length === 3).map((call) => call[0]).sort()).toEqual(["session:0.0", "session:0.1"]);

    liveHandlers.get("session:0.0")!(bytes("LIVE A\n"));
    liveHandlers.get("session:0.1")!(bytes("LIVE B\n"));
    expect(sent.slice(2).map(frame)).toEqual([
      { type: "maw-share-frame", pane: "session:0.0", data: "LIVE A\n" },
      { type: "maw-share-frame", pane: "session:0.1", data: "LIVE B\n" },
    ]);

    childResolvers.get("session:0.0")?.();
    childResolvers.get("session:0.1")?.();
    await handle.close();

    expect(localPipeCalls.filter((call) => call.length === 1).map((call) => call[0]).sort()).toEqual(["session:0.0", "session:0.1"]);
    expect(localKillCalls.map(([target, signal]) => `${target}:${signal}`).sort()).toEqual(["session:0.0:SIGTERM", "session:0.1:SIGTERM"]);
  });
  test("source pane resize pushes dimension-only frames without resizing tmux", async () => {
    const share: Share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 1_000_000,
      auth: "token",
    };
    const sent: Array<WsMessage> = [];
    const timers: Array<() => void> = [];
    const pipeCalls: Array<Array<unknown>> = [];
    const resizeCalls: unknown[] = [];
    let dims = "106 51";
    let childResolve: (() => void) | null = null;

    const handle = await attach(share, { send: (data: WsMessage) => sent.push(data) } as any, {
      tmux: {
        run: async () => dims,
        capture: async () => "SNAPSHOT\n",
        pipePane: async (...args: unknown[]) => { pipeCalls.push(args); },
        resizePane: async (...args: unknown[]) => { resizeCalls.push(args); },
      },
      makeFifo: async () => undefined,
      spawnPipeReader: async () => ({
        kill: () => undefined,
        exited: new Promise((resolve) => { childResolve = () => resolve(0); }),
      }),
      setInterval: ((fn: () => void) => { timers.push(fn); return fn as any; }) as any,
      clearInterval: (() => undefined) as any,
    } as any);

    expect(frame(sent[0]!)).toEqual({ type: "maw-share-frame", pane: "session:0", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 106, rows: 51 } });
    dims = "106 44";
    timers[0]!();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(frame(sent.at(-1)!)).toEqual({ type: "maw-share-frame", pane: "session:0", data: "", dimensions: { cols: 106, rows: 44 } });
    expect(resizeCalls).toEqual([]);

    childResolve?.();
    await handle.close();
  });

});
