import { describe, expect, test } from "bun:test";

import { capturePayload, createTmuxStreamConnection, layoutPayload, TMUX_STREAM_INTERVAL_MS } from "../../src/api/tmux-stream";

describe("tmux websocket stream (#2048)", () => {
  test("formats layout and capture payloads for tmux-viewer protocol", () => {
    expect(JSON.parse(layoutPayload([{ id: "%1", top: 1, left: 2 }]))).toEqual({
      type: "layout",
      panes: [{ id: "%1", top: 1, left: 2 }],
    });
    expect(JSON.parse(capturePayload({ "%1": "hello" }))).toEqual({
      type: "capture",
      captures: { "%1": "hello" },
    });
  });

  test("sends immediate snapshots, then capture updates only when content changes", async () => {
    const sent: string[] = [];
    const callbacks: Array<() => void> = [];
    const pipeCalls: Array<{ paneId: string; command?: string; opts?: unknown }> = [];
    let captureText = "first";
    const ws = { send: (payload: string) => { sent.push(payload); } };

    const connection = createTmuxStreamConnection(ws, {
      layoutRows: async () => [{ id: "%1", target: "demo:0.0", top: 0, left: 0, w: 80, h: 24 }],
      listPanes: async () => [{ id: "%1" }],
      capturePane: async () => captureText,
      pipePane: async (paneId, command, opts) => { pipeCalls.push({ paneId, command, opts }); },
      spawnTail: async () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      setIntervalFn: ((fn: () => void, ms?: number) => {
        expect(ms).toBe(TMUX_STREAM_INTERVAL_MS);
        callbacks.push(fn);
        return callbacks.length as any;
      }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await Bun.sleep(0);
    expect(sent.map(payload => JSON.parse(payload).type)).toEqual(["layout", "capture"]);
    expect(callbacks).toHaveLength(1);
    expect(pipeCalls).toHaveLength(1);
    expect(pipeCalls[0]).toMatchObject({ paneId: "%1", opts: { onlyIfClosed: true } });
    expect(JSON.parse(sent[0]!).panes[0]).toMatchObject({ id: "%1", top: 0, left: 0, w: 80, h: 24 });
    expect(JSON.parse(sent[1]!).captures).toEqual({ "%1": "first" });

    await connection.sendCapture();
    expect(sent).toHaveLength(2);

    captureText = "second";
    await connection.sendCapture();
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "second" });

    connection.close();
    await Bun.sleep(0);
  });

  test("pushes pane output through one refcounted pipe across multiple viewers", async () => {
    const sentA: string[] = [];
    const sentB: string[] = [];
    const pipeCalls: Array<{ paneId: string; command?: string; opts?: unknown }> = [];
    const killCalls: string[] = [];
    let onChunk: ((chunk: Uint8Array) => void) | undefined;
    const commonDeps = {
      startTimers: false,
      layoutRows: async () => [],
      listPanes: async () => [{ id: "%1" }],
      capturePane: async () => "snapshot\n",
      pipePane: async (paneId: string, command?: string, opts?: unknown) => {
        pipeCalls.push({ paneId, command, opts });
      },
      spawnTail: async (_path: string, chunk: (data: Uint8Array) => void) => {
        onChunk = chunk;
        return { kill: (signal?: string | number) => { killCalls.push(String(signal)); }, exited: new Promise(() => {}) };
      },
    };

    const one = createTmuxStreamConnection({ send: (payload: string) => sentA.push(payload) }, commonDeps);
    await one.sendCapture({ force: true });
    const two = createTmuxStreamConnection({ send: (payload: string) => sentB.push(payload) }, commonDeps);
    await two.sendCapture({ force: true });

    expect(pipeCalls).toHaveLength(1);
    expect(pipeCalls[0]).toMatchObject({ paneId: "%1", opts: { onlyIfClosed: true } });

    onChunk!(new TextEncoder().encode("live\n"));
    await Bun.sleep(0);
    expect(JSON.parse(sentA.at(-1)!).captures["%1"]).toBe("snapshot\nlive\n");
    expect(JSON.parse(sentB.at(-1)!).captures["%1"]).toBe("snapshot\nlive\n");

    one.close();
    await Bun.sleep(0);
    expect(pipeCalls).toHaveLength(1);
    expect(killCalls).toEqual([]);

    two.close();
    await Bun.sleep(0);
    expect(pipeCalls.at(-1)).toEqual({ paneId: "%1", command: undefined, opts: undefined });
    expect(killCalls).toEqual(["SIGTERM"]);
  });

  test("logs pane capture failures and keeps last good capture instead of blanking panes", async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const pipeCalls: string[] = [];
    let fail = false;
    const ws = { send: (payload: string) => { sent.push(payload); } };

    const connection = createTmuxStreamConnection(ws, {
      startTimers: false,
      layoutRows: async () => [],
      listPanes: async () => [{ id: "%1" }],
      capturePane: async () => {
        if (fail) throw new Error("pane disappeared");
        return "healthy";
      },
      pipePane: async (paneId, command) => { pipeCalls.push(`${paneId}:${command ?? "<close>"}`); },
      spawnTail: async () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      onError: (message, error) => errors.push(`${message}: ${error instanceof Error ? error.message : String(error)}`),
    });

    await connection.sendCapture({ force: true });
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "healthy" });

    fail = true;
    await connection.sendCapture({ force: true });

    expect(errors).toEqual(["capture failed for pane %1: pane disappeared"]);
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "healthy" });
    connection.close();
    await Bun.sleep(0);
  });

});
