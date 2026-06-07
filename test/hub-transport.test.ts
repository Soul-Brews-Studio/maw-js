import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../src/lib/feed";
import type { HubConnection } from "../src/transports/hub-connection";
import type { WorkspaceConfig } from "../src/transports/hub-config";
import { HubTransport } from "../src/transports/hub-transport";

function workspace(id = "ws-a"): WorkspaceConfig {
  return {
    id,
    hubUrl: `ws://${id}.example/ws`,
    token: "workspace-token",
    sharedAgents: ["mawjs"],
  };
}

function conn(id: string, connected: boolean, agents: string[], sent: string[] = []): HubConnection {
  return {
    config: workspace(id),
    ws: {
      send(payload: string) {
        sent.push(payload);
      },
    } as unknown as WebSocket,
    connected,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(agents),
  };
}

function feedEvent(): FeedEvent {
  return {
    timestamp: "2026-05-17 00:00:00",
    oracle: "pulse",
    host: "m5",
    event: "MessageSend",
    project: "maw-js",
    sessionId: "test",
    message: "hello",
    ts: 1,
  };
}

describe("HubTransport", () => {
  test("connect reports no workspace configs without marking connected", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const transport = new HubTransport(undefined, {
        loadConfig: () => ({ node: "m5" } as any),
        loadWorkspaces: () => [],
      });

      await transport.connect();
      expect(transport.name).toBe("workspace-hub");
      expect(transport.priority).toBe(30);
      expect(transport.connected).toBe(false);
      expect(logs.join("\n")).toContain("no workspace configs found");
    } finally {
      console.log = originalLog;
    }
  });

  test("connect marks connected when a workspace reaches first-connect callback", async () => {
    const ws = workspace("ws-ok");
    const opened: Array<{ id: string; nodeId: string; token?: string }> = [];
    let cleared = 0;
    const transport = new HubTransport(undefined, {
      loadConfig: () => ({ node: "m5", federationToken: "fed-secret" } as any),
      loadWorkspaces: () => [ws],
      setConnectTimeout: (() => ({ kind: "timeout" })) as typeof setTimeout,
      clearConnectTimeout: (() => { cleared += 1; }) as typeof clearTimeout,
      openSocket: (connection, nodeId, federationToken, _msg, _presence, _feed, onSetConnected, _onUpdateState, onFirstConnect) => {
        opened.push({ id: connection.config.id, nodeId, token: federationToken });
        connection.connected = true;
        onSetConnected();
        onFirstConnect?.();
      },
    });

    await transport.connect();
    expect(transport.connected).toBe(true);
    expect(opened).toEqual([{ id: "ws-ok", nodeId: "m5", token: "fed-secret" }]);
    expect(cleared).toBe(1);
    expect(transport.workspaceStatus()).toEqual([
      { id: "ws-ok", connected: true, remoteAgents: [] },
    ]);
  });

  test("connect timeout leaves transport disconnected", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const transport = new HubTransport("forced-node", {
        loadConfig: () => ({ node: "ignored" } as any),
        loadWorkspaces: () => [workspace("ws-timeout")],
        setConnectTimeout: ((cb: () => void) => {
          cb();
          return { kind: "timeout" };
        }) as typeof setTimeout,
        openSocket: () => {},
      });

      await transport.connect();
      expect(transport.connected).toBe(false);
      expect(warnings.join("\n")).toContain("workspace ws-timeout: connection timeout");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("routes sends, publishes best-effort events, reports status, and disconnects", async () => {
    const cleanups: string[] = [];
    const warnLogs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLogs.push(args.map(String).join(" "));
    try {
      const transport = new HubTransport("m5", {
        loadConfig: () => ({ federationToken: "fed" } as any),
        cleanup: (connection) => {
          cleanups.push(connection.config.id);
          connection.connected = false;
        },
      });
      const sentA: string[] = [];
      const sentB: string[] = [];
      const sentThrow: string[] = [];
      const throwing = conn("ws-throw", true, ["remote:pulse"], sentThrow);
      throwing.ws = {
        send(payload: string) {
          sentThrow.push(payload);
          throw new Error("socket closed");
        },
      } as unknown as WebSocket;
      const connected = conn("ws-b", true, ["pulse", "remote:pulse"], sentB);
      const disconnected = conn("ws-a", false, ["pulse"], sentA);
      (transport as any).connections.set("ws-a", disconnected);
      (transport as any).connections.set("ws-throw", throwing);
      (transport as any).connections.set("ws-b", connected);

      expect(transport.canReach({ oracle: "pulse", host: "remote" })).toBe(false);
      (transport as any)._connected = true;
      expect(transport.canReach({ oracle: "pulse", host: "remote" })).toBe(true);
      expect(transport.canReach({ oracle: "ghost", host: "remote" })).toBe(false);

      expect(await transport.send({ oracle: "pulse", host: "remote" }, "hello")).toBe(true);
      expect(JSON.parse(sentB[0])).toMatchObject({
        type: "message",
        to: "remote:pulse",
        body: "hello",
        from: "m5:pulse",
      });
      expect(warnLogs.join("\n")).toContain("send failed on workspace ws-throw");
      expect(await transport.send({ oracle: "ghost", host: "remote" }, "hello")).toBe(false);

      await transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 123 });
      await transport.publishFeed(feedEvent());
      expect(sentA).toEqual([]);
      expect(sentB.map((payload) => JSON.parse(payload).type)).toEqual(["message", "presence", "feed"]);

      expect(transport.workspaceStatus()).toEqual([
        { id: "ws-a", connected: false, remoteAgents: ["pulse"] },
        { id: "ws-throw", connected: true, remoteAgents: ["remote:pulse"] },
        { id: "ws-b", connected: true, remoteAgents: ["pulse", "remote:pulse"] },
      ]);

      await transport.disconnect();
      expect(cleanups).toEqual(["ws-a", "ws-throw", "ws-b"]);
      expect(transport.connected).toBe(false);
      expect(transport.workspaceStatus()).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("registers handlers for openSocket wiring", async () => {
    const transport = new HubTransport("m5", {
      loadConfig: () => ({} as any),
      loadWorkspaces: () => [workspace("ws-handlers")],
      setConnectTimeout: (() => ({ kind: "timeout" })) as typeof setTimeout,
      clearConnectTimeout: (() => {}) as typeof clearTimeout,
      openSocket: (_connection, _nodeId, _token, msgHandlers, presenceHandlers, feedHandlers, _onSetConnected, _onUpdateState, onFirstConnect) => {
        expect(msgHandlers.size).toBe(1);
        expect(presenceHandlers.size).toBe(1);
        expect(feedHandlers.size).toBe(1);
        onFirstConnect?.();
      },
    });
    transport.onMessage(() => {});
    transport.onPresence(() => {});
    transport.onFeed(() => {});

    await transport.connect();
    expect(transport.connected).toBe(true);
  });
});
