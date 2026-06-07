import { afterEach, describe, expect, test } from "bun:test";
import { HubTransport } from "../../src/transports/hub-transport";
import { LoRaTransport } from "../../src/transports/lora";
import type { HubConnection } from "../../src/transports/hub-connection";
import {
  cleanupConnection,
  handleMessage,
  openWebSocket,
  scheduleReconnect,
  sendAuth,
  startHeartbeat,
  stopHeartbeat,
} from "../../src/transports/hub-connection";

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.WebSocket = originalWebSocket;
});

function makeConn(id = "workspace"): HubConnection {
  return {
    config: {
      id,
      hubUrl: `ws://${id}.example.test`,
      token: `token-${id}`,
      sharedAgents: ["local-agent"],
    },
    ws: null,
    connected: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(),
  };
}

describe("hub connection coverage", () => {
  test("sendAuth handles closed sockets and signed auth payloads", () => {
    const conn = makeConn("auth");
    sendAuth(conn, "node-a", undefined);

    const sent: any[] = [];
    conn.ws = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => sent.push(JSON.parse(payload)),
    } as any;

    sendAuth(conn, "node-a", undefined);
    sendAuth(conn, "node-a", "secret-token");

    expect(sent[0]).toMatchObject({
      type: "auth",
      token: "token-auth",
      nodeId: "node-a",
      sharedAgents: ["local-agent"],
    });
    expect(sent[0]._sig).toBeUndefined();
    expect(sent[1]._sig).toEqual(expect.any(String));
    expect(sent[1]._ts).toEqual(sent[1].timestamp);
  });

  test("handleMessage covers all message variants and defaults", () => {
    const conn = makeConn("messages");
    const logs: string[] = [];
    const errors: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

    const messages: any[] = [];
    const presences: any[] = [];
    const feeds: any[] = [];
    const msgHandlers = new Set<((msg: any) => void)>([(msg) => messages.push(msg)]);
    const presenceHandlers = new Set<((presence: any) => void)>([(presence) => presences.push(presence)]);
    const feedHandlers = new Set<((event: any) => void)>([(event) => feeds.push(event)]);

    handleMessage(conn, JSON.stringify({ type: "auth-ok", workspaceId: "ws\nbad", agents: ["alpha", "omega"] }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "message" }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({
      type: "presence",
      timestamp: 123,
      agents: [
        { name: "neo", host: "white", status: "busy" },
        { nodeId: "remote-node" },
      ],
    }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "node-joined", nodeId: "new\nnode" }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "node-left", nodeId: "old\nnode", agents: ["alpha"] }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "feed", event: { kind: "note", body: "hello" } }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "error", reason: "bad\nreason" }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, JSON.stringify({ type: "unknown" }), msgHandlers, presenceHandlers, feedHandlers);
    handleMessage(conn, "{not json", msgHandlers, presenceHandlers, feedHandlers);

    expect(conn.remoteAgents.has("omega")).toBe(true);
    expect(conn.remoteAgents.has("alpha")).toBe(false);
    expect(conn.remoteAgents.has("neo")).toBe(true);
    expect(messages[0]).toMatchObject({
      from: "unknown",
      to: "unknown",
      body: "",
      transport: "hub",
    });
    expect(presences).toEqual([
      { oracle: "neo", host: "white", status: "busy", timestamp: 123 },
      { oracle: "unknown", host: "remote-node", status: "ready", timestamp: 123 },
    ]);
    expect(feeds).toEqual([{ kind: "note", body: "hello" }]);
    expect(logs.join("\n")).toContain("authenticated");
    expect(logs.join("\n")).not.toContain("new\nnode");
    expect(errors.join("\n")).toContain("hub error");
    expect(errors.join("\n")).not.toContain("bad\nreason");
  });

  test("heartbeat, reconnect, and cleanup use timers and close sockets safely", () => {
    const conn = makeConn("timers");
    const sent: string[] = [];
    const closed: string[] = [];
    conn.ws = {
      readyState: WebSocket.OPEN,
      send: (payload: string) => sent.push(payload),
      close: (code?: number, reason?: string) => closed.push(`${code ?? ""}:${reason ?? ""}`),
    } as any;

    let intervalCallback: (() => void) | undefined;
    const clearedIntervals: unknown[] = [];
    globalThis.setInterval = ((fn: () => void) => {
      intervalCallback = fn;
      return 101 as any;
    }) as any;
    globalThis.clearInterval = ((timer: unknown) => {
      clearedIntervals.push(timer);
    }) as any;

    startHeartbeat(conn, "node-a");
    intervalCallback?.();
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "heartbeat", nodeId: "node-a" });
    stopHeartbeat(conn);
    expect(conn.heartbeatTimer).toBeNull();
    expect(clearedIntervals).toEqual([101]);

    let timeoutCallback: (() => void) | undefined;
    const clearedTimeouts: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void) => {
      timeoutCallback = fn;
      return 202 as any;
    }) as any;
    globalThis.clearTimeout = ((timer: unknown) => {
      clearedTimeouts.push(timer);
    }) as any;

    let opened = 0;
    scheduleReconnect(conn, () => {
      opened++;
    });
    scheduleReconnect(conn, () => {
      opened += 10;
    });
    expect(conn.reconnectAttempt).toBe(1);
    timeoutCallback?.();
    expect(opened).toBe(1);
    expect(closed).toContain(":");

    conn.reconnectTimer = 303 as any;
    conn.connected = true;
    conn.ws = {
      close: (code?: number, reason?: string) => closed.push(`${code}:${reason}`),
    } as any;
    cleanupConnection(conn);
    expect(clearedTimeouts).toContain(303);
    expect(conn.ws).toBeNull();
    expect(conn.connected).toBe(false);
    expect(closed).toContain("1000:transport disconnect");
  });

  test("openWebSocket wires lifecycle callbacks and constructor failures to reconnect", () => {
    const instances: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      static failNext = false;
      readyState = 1;
      handlers = new Map<string, Array<(event: any) => void>>();
      sent: string[] = [];
      closed = false;
      constructor(readonly url: string) {
        if (FakeSocket.failNext) {
          FakeSocket.failNext = false;
          throw new Error("constructor failed");
        }
        instances.push(this);
      }
      addEventListener(type: string, handler: (event: any) => void) {
        const existing = this.handlers.get(type) ?? [];
        existing.push(handler);
        this.handlers.set(type, existing);
      }
      emit(type: string, event: any = {}) {
        for (const handler of this.handlers.get(type) ?? []) handler(event);
      }
      send(payload: string) {
        this.sent.push(payload);
      }
      close() {
        this.closed = true;
      }
    }
    globalThis.WebSocket = FakeSocket as any;

    const timers: Array<() => void> = [];
    globalThis.setInterval = (() => 404 as any) as any;
    globalThis.clearInterval = (() => undefined) as any;
    globalThis.setTimeout = ((fn: () => void) => {
      timers.push(fn);
      return 505 as any;
    }) as any;

    const conn = makeConn("socket");
    let setConnected = 0;
    let updateState = 0;
    let firstConnect = 0;
    const feeds: any[] = [];

    openWebSocket(
      conn,
      "node-a",
      undefined,
      new Set(),
      new Set(),
      new Set([(event: any) => feeds.push(event)]),
      () => { setConnected++; },
      () => { updateState++; },
      () => { firstConnect++; },
    );

    instances[0]!.emit("open");
    instances[0]!.emit("message", { data: JSON.stringify({ type: "feed", event: { kind: "socket-feed" } }) });
    instances[0]!.emit("message", { data: 123 });
    instances[0]!.emit("error", {});
    instances[0]!.emit("close", { code: 1006, reason: "lost" });

    expect(conn.connected).toBe(false);
    expect(setConnected).toBe(1);
    expect(firstConnect).toBe(1);
    expect(updateState).toBe(1);
    expect(feeds).toEqual([{ kind: "socket-feed" }]);
    expect(timers.length).toBe(1);
    timers[0]!();
    expect(instances.length).toBe(2);
    expect(instances[0]!.closed).toBe(true);

    const failed = makeConn("fail");
    FakeSocket.failNext = true;
    openWebSocket(failed, "node-a", undefined, new Set(), new Set(), new Set(), () => undefined, () => undefined);
    expect(failed.reconnectTimer).not.toBeNull();
  });
});

describe("hub transport coverage", () => {
  test("connect handles no workspace configs", async () => {
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const transport = new HubTransport(undefined, {
      loadConfig: () => ({ node: "configured-node", federationToken: "secret" }) as any,
      loadWorkspaces: () => [],
    });

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(logs.join("\n")).toContain("no workspace configs found");
  });

  test("connect, send, publish, reachability, status, and disconnect use injected connections", async () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const timeoutCallbacks: Array<() => void> = [];
    const clearedTimeouts: unknown[] = [];
    const cleaned: string[] = [];
    const sent: string[] = [];
    const handlerSizes: number[] = [];

    const transport = new HubTransport("node-a", {
      loadConfig: () => ({ node: "ignored-node" }) as any,
      loadWorkspaces: () => [
        { id: "one", hubUrl: "ws://one.example.test", token: "one", sharedAgents: [] },
        { id: "two", hubUrl: "ws://two.example.test", token: "two", sharedAgents: [] },
        { id: "slow", hubUrl: "ws://slow.example.test", token: "slow", sharedAgents: [] },
      ],
      setConnectTimeout: ((fn: () => void) => {
        timeoutCallbacks.push(fn);
        return timeoutCallbacks.length as any;
      }) as any,
      clearConnectTimeout: ((timer: unknown) => {
        clearedTimeouts.push(timer);
      }) as any,
      cleanup: (conn) => {
        cleaned.push(conn.config.id);
        conn.connected = false;
      },
      openSocket: (conn, _node, _token, msgHandlers, presenceHandlers, feedHandlers, setConnected, updateState, firstConnect) => {
        handlerSizes.push(msgHandlers.size, presenceHandlers.size, feedHandlers.size);
        if (conn.config.id === "slow") return;
        conn.connected = true;
        conn.remoteAgents.add("target");
        conn.remoteAgents.add("remote:target");
        conn.ws = {
          send: (payload: string) => {
            if (conn.config.id === "one" && payload.includes("\"type\":\"message\"")) {
              throw new Error("send failed");
            }
            sent.push(`${conn.config.id}:${payload}`);
          },
        } as any;
        setConnected();
        updateState();
        firstConnect?.();
      },
    });

    transport.onMessage(() => undefined);
    transport.onPresence(() => undefined);
    transport.onFeed(() => undefined);

    const connectPromise = transport.connect();
    await Promise.resolve();
    for (const callback of timeoutCallbacks) callback();
    await connectPromise;

    expect(transport.connected).toBe(true);
    expect(clearedTimeouts).toEqual([1, 2]);
    expect(warnings.join("\n")).toContain("workspace slow: connection timeout");
    expect(handlerSizes).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(transport.workspaceStatus()).toEqual([
      { id: "one", connected: true, remoteAgents: ["target", "remote:target"] },
      { id: "two", connected: true, remoteAgents: ["target", "remote:target"] },
      { id: "slow", connected: false, remoteAgents: [] },
    ]);

    expect(transport.canReach({ oracle: "target" })).toBe(true);
    expect(transport.canReach({ host: "remote", oracle: "target" })).toBe(true);
    expect(await transport.send({ host: "remote", oracle: "target" }, "hello")).toBe(true);
    expect(warnings.join("\n")).toContain("send failed on workspace one");
    expect(sent.some((payload) => payload.includes('"to":"remote:target"'))).toBe(true);
    expect(sent.some((payload) => payload.includes('"from":"node-a:target"'))).toBe(true);

    await transport.publishPresence({ oracle: "target", host: "node-a", status: "ready", timestamp: 42 });
    await transport.publishFeed({ kind: "note", body: "hello" } as any);
    expect(sent.some((payload) => payload.includes('"type":"presence"'))).toBe(true);
    expect(sent.some((payload) => payload.includes('"type":"feed"'))).toBe(true);

    await transport.disconnect();
    expect(cleaned).toEqual(["one", "two", "slow"]);
    expect(transport.connected).toBe(false);
    expect(transport.workspaceStatus()).toEqual([]);
    expect(transport.canReach({ oracle: "target" })).toBe(false);
  });
});

describe("lora transport coverage", () => {
  test("stub transport methods stay disconnected and best-effort", async () => {
    const transport = new LoRaTransport();
    const messageHandler = () => undefined;
    const presenceHandler = () => undefined;
    const feedHandler = () => undefined;

    transport.onMessage(messageHandler);
    transport.onPresence(presenceHandler);
    transport.onFeed(feedHandler);

    expect(transport.name).toBe("lora");
    expect(transport.connected).toBe(false);
    await transport.connect();
    expect(transport.connected).toBe(false);
    expect(await transport.send({ oracle: "any" }, "hello")).toBe(false);
    await transport.publishPresence({ oracle: "any", host: "local", status: "ready", timestamp: 1 });
    await transport.publishFeed({ kind: "note" } as any);
    expect(transport.canReach({ oracle: "any" })).toBe(false);
    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });
});
