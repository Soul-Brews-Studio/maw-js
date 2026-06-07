import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../src/lib/feed";
import type { TransportMessage, TransportPresence } from "../src/core/transport/transport";
import type { HubConnection } from "../src/transports/hub-connection";
import {
  cleanupConnection,
  handleMessage,
  openWebSocket,
  scheduleReconnect,
  sendAuth,
  startHeartbeat,
  stopHeartbeat,
} from "../src/transports/hub-connection";

function makeConn(id = "ws-test"): HubConnection {
  return {
    config: {
      id,
      hubUrl: `ws://${id}.example/ws`,
      token: "workspace-token",
      sharedAgents: ["mawjs", "pulse"],
    },
    ws: null,
    connected: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(),
  };
}

function withConsoleCapture<T>(fn: (logs: string[]) => T): T {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    return fn(logs);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("hub connection lifecycle helpers", () => {
  test("sendAuth signs and skips unavailable sockets", () => {
    const conn = makeConn();
    sendAuth(conn, "m5", "secret");

    const closedSocket = { readyState: 3, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
    conn.ws = closedSocket as unknown as WebSocket;
    sendAuth(conn, "m5", "secret");
    expect(closedSocket.sent).toEqual([]);

    const openSocket = { readyState: WebSocket.OPEN, sent: [] as string[], send(payload: string) { this.sent.push(payload); } };
    conn.ws = openSocket as unknown as WebSocket;
    sendAuth(conn, "m5", "secret");

    expect(openSocket.sent).toHaveLength(1);
    const payload = JSON.parse(openSocket.sent[0]);
    expect(payload).toMatchObject({
      type: "auth",
      token: "workspace-token",
      nodeId: "m5",
      sharedAgents: ["mawjs", "pulse"],
    });
    expect(typeof payload.timestamp).toBe("number");
    expect(payload._ts).toBe(payload.timestamp);
    expect(typeof payload._sig).toBe("string");
  });

  test("handleMessage updates agents and dispatches message, presence, and feed events", () => {
    const conn = makeConn();
    const messages: TransportMessage[] = [];
    const presences: TransportPresence[] = [];
    const feeds: FeedEvent[] = [];
    const msgHandlers = new Set<(msg: TransportMessage) => void>([(msg) => messages.push(msg)]);
    const presenceHandlers = new Set<(p: TransportPresence) => void>([(p) => presences.push(p)]);
    const feedHandlers = new Set<(e: FeedEvent) => void>([(e) => feeds.push(e)]);

    withConsoleCapture((logs) => {
      handleMessage(conn, JSON.stringify({ type: "auth-ok", workspaceId: "prod\u001b[31m", agents: ["pulse", "neo"] }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "message", from: "pulse", to: "mawjs", body: "hello", timestamp: 123 }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "presence", timestamp: 456, agents: [{ name: "iris", host: "m5", status: "busy" }, { nodeId: "m6" }] }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "node-joined", nodeId: "clinic\u001b[31m" }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "node-left", nodeId: "m6", agents: ["pulse"] }), msgHandlers, presenceHandlers, feedHandlers);
      const feed = { timestamp: "2026-05-17 00:00:00", oracle: "pulse", host: "m5", event: "MessageSend", project: "maw-js", sessionId: "s", message: "hi", ts: 1 } as FeedEvent;
      handleMessage(conn, JSON.stringify({ type: "feed", event: feed }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "error", message: "bad\u001b[31m" }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, JSON.stringify({ type: "unknown" }), msgHandlers, presenceHandlers, feedHandlers);
      handleMessage(conn, "not-json", msgHandlers, presenceHandlers, feedHandlers);

      expect(logs.join("\n")).toContain("authenticated");
      expect(logs.join("\n")).not.toContain("\u001b[31m");
    });

    expect(conn.remoteAgents.has("neo")).toBe(true);
    expect(conn.remoteAgents.has("pulse")).toBe(false);
    expect(conn.remoteAgents.has("iris")).toBe(true);
    expect(messages).toEqual([{ from: "pulse", to: "mawjs", body: "hello", timestamp: 123, transport: "hub" }]);
    expect(presences).toEqual([
      { oracle: "iris", host: "m5", status: "busy", timestamp: 456 },
      { oracle: "unknown", host: "m6", status: "ready", timestamp: 456 },
    ]);
    expect(feeds).toHaveLength(1);
    expect(feeds[0].oracle).toBe("pulse");
  });

  test("heartbeat, reconnect, and cleanup manage timers and sockets", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const intervals: number[] = [];
    const clearedIntervals: unknown[] = [];
    const clearedTimeouts: unknown[] = [];
    let reconnectCallback: (() => void) | null = null;
    try {
      (globalThis as any).setInterval = (cb: () => void, ms: number) => {
        intervals.push(ms);
        cb();
        return { kind: "interval" };
      };
      (globalThis as any).clearInterval = (handle: unknown) => clearedIntervals.push(handle);
      (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
        reconnectCallback = cb;
        return { kind: "timeout", ms };
      };
      (globalThis as any).clearTimeout = (handle: unknown) => clearedTimeouts.push(handle);

      const sent: string[] = [];
      const closed: string[] = [];
      const conn = makeConn();
      conn.ws = {
        readyState: WebSocket.OPEN,
        send: (payload: string) => sent.push(payload),
        close: (_code?: number, reason?: string) => closed.push(reason ?? ""),
      } as unknown as WebSocket;

      startHeartbeat(conn, "m5");
      expect(intervals).toEqual([30_000]);
      expect(JSON.parse(sent[0])).toMatchObject({ type: "heartbeat", nodeId: "m5" });
      stopHeartbeat(conn);
      expect(conn.heartbeatTimer).toBeNull();
      expect(clearedIntervals).toHaveLength(1);

      withConsoleCapture(() => {
        scheduleReconnect(conn, () => closed.push("reopened"));
        scheduleReconnect(conn, () => closed.push("guarded"));
      });
      expect(conn.reconnectAttempt).toBe(1);
      expect(reconnectCallback).toBeTruthy();
      reconnectCallback?.();
      expect(closed).toContain("reopened");
      expect(closed).not.toContain("guarded");

      cleanupConnection(conn);
      expect(conn.connected).toBe(false);
      expect(conn.ws).toBeNull();
      expect(conn.reconnectTimer).toBeNull();

      const timerOnly = makeConn();
      timerOnly.reconnectTimer = { kind: "pending-timeout" } as ReturnType<typeof setTimeout>;
      cleanupConnection(timerOnly);
      expect(clearedTimeouts).toHaveLength(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("openWebSocket wires auth, events, close-state updates, and creation failures", () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const instances: FakeWebSocket[] = [];
    let shouldThrow = false;

    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      sent: string[] = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      constructor(public url: string) {
        if (shouldThrow) throw new Error("constructor boom");
        instances.push(this);
      }
      addEventListener(type: string, handler: (event: any) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
      }
      send(payload: string) { this.sent.push(payload); }
      close() {}
      emit(type: string, event: any = {}) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
    }

    try {
      (globalThis as any).WebSocket = FakeWebSocket;
      (globalThis as any).setInterval = () => ({ kind: "interval" });
      (globalThis as any).clearInterval = () => {};
      (globalThis as any).setTimeout = () => ({ kind: "timeout" });
      (globalThis as any).clearTimeout = () => {};

      const conn = makeConn("ws-open");
      const messages: TransportMessage[] = [];
      let setConnected = 0;
      let updateState = 0;
      let firstConnect = 0;
      withConsoleCapture(() => {
        openWebSocket(
          conn,
          "m5",
          undefined,
          new Set([(msg) => messages.push(msg)]),
          new Set(),
          new Set(),
          () => { setConnected += 1; },
          () => { updateState += 1; },
          () => { firstConnect += 1; },
        );

        const ws = instances[0];
        ws.emit("open");
        expect(conn.connected).toBe(true);
        expect(setConnected).toBe(1);
        expect(firstConnect).toBe(1);
        expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "auth", nodeId: "m5" });

        ws.emit("message", { data: JSON.stringify({ type: "message", from: "pulse", to: "mawjs", body: "hi", timestamp: 7 }) });
        ws.emit("error", { message: "network broke" });
        ws.emit("close", { code: 1006, reason: "lost" });
      });
      expect(messages).toEqual([{ from: "pulse", to: "mawjs", body: "hi", timestamp: 7, transport: "hub" }]);
      expect(conn.connected).toBe(false);
      expect(updateState).toBe(1);
      cleanupConnection(conn);

      const failed = makeConn("ws-fail");
      shouldThrow = true;
      withConsoleCapture(() => {
        openWebSocket(failed, "m5", undefined, new Set(), new Set(), new Set(), () => {}, () => {});
      });
      expect(failed.reconnectTimer).toBeTruthy();
      cleanupConnection(failed);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
