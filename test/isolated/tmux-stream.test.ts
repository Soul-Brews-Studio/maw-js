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
    let captureText = "first";
    const ws = { send: (payload: string) => { sent.push(payload); } };

    const connection = createTmuxStreamConnection(ws, {
      layoutRows: async () => [{ id: "%1", target: "demo:0.0", top: 0, left: 0, w: 80, h: 24 }],
      listPanes: async () => [{ id: "%1" }],
      capturePane: async () => captureText,
      setIntervalFn: ((fn: () => void, ms?: number) => {
        expect(ms).toBe(TMUX_STREAM_INTERVAL_MS);
        callbacks.push(fn);
        return callbacks.length as any;
      }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await Bun.sleep(0);
    expect(sent.map(payload => JSON.parse(payload).type)).toEqual(["layout", "capture"]);
    expect(JSON.parse(sent[0]!).panes[0]).toMatchObject({ id: "%1", top: 0, left: 0, w: 80, h: 24 });
    expect(JSON.parse(sent[1]!).captures).toEqual({ "%1": "first" });

    await connection.sendCapture();
    expect(sent).toHaveLength(2);

    captureText = "second";
    await connection.sendCapture();
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "second" });

    connection.close();
  });

  test("logs pane capture failures and keeps last good capture instead of blanking panes", async () => {
    const sent: string[] = [];
    const errors: string[] = [];
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
      onError: (message, error) => errors.push(`${message}: ${error instanceof Error ? error.message : String(error)}`),
    });

    await connection.sendCapture({ force: true });
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "healthy" });

    fail = true;
    await connection.sendCapture({ force: true });

    expect(errors).toEqual(["capture failed for pane %1: pane disappeared"]);
    expect(JSON.parse(sent.at(-1)!).captures).toEqual({ "%1": "healthy" });
    connection.close();
  });

});
