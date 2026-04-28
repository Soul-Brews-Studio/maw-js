/**
 * Tests for hub connection lifecycle functions from src/transports/hub-connection.ts.
 * Tests stopHeartbeat, cleanupConnection, scheduleReconnect — no real WebSocket needed.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  stopHeartbeat,
  cleanupConnection,
  scheduleReconnect,
  type HubConnection,
} from "../../src/transports/hub-connection";
import type { WorkspaceConfig } from "../../src/transports/hub-config";

function makeConfig(): WorkspaceConfig {
  return {
    id: "test-ws",
    token: "test-token",
    hubUrl: "ws://localhost:9999",
    sharedAgents: [],
  };
}

function makeConn(overrides: Partial<HubConnection> = {}): HubConnection {
  return {
    config: makeConfig(),
    ws: null,
    connected: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(),
    ...overrides,
  };
}

describe("stopHeartbeat", () => {
  it("clears heartbeat timer", () => {
    const timer = setInterval(() => {}, 999999);
    const conn = makeConn({ heartbeatTimer: timer });
    stopHeartbeat(conn);
    expect(conn.heartbeatTimer).toBeNull();
  });

  it("no-ops when no timer set", () => {
    const conn = makeConn();
    expect(() => stopHeartbeat(conn)).not.toThrow();
    expect(conn.heartbeatTimer).toBeNull();
  });
});

describe("cleanupConnection", () => {
  it("clears heartbeat and reconnect timers", () => {
    const hb = setInterval(() => {}, 999999);
    const rc = setTimeout(() => {}, 999999);
    const conn = makeConn({
      heartbeatTimer: hb,
      reconnectTimer: rc,
      connected: true,
    });
    cleanupConnection(conn);
    expect(conn.heartbeatTimer).toBeNull();
    expect(conn.reconnectTimer).toBeNull();
    expect(conn.connected).toBe(false);
  });

  it("closes WebSocket if present", () => {
    let closeCalled = false;
    const fakeWs = {
      close: (code?: number, reason?: string) => { closeCalled = true; },
      readyState: 1,
    };
    const conn = makeConn({ ws: fakeWs as any, connected: true });
    cleanupConnection(conn);
    expect(closeCalled).toBe(true);
    expect(conn.ws).toBeNull();
    expect(conn.connected).toBe(false);
  });

  it("no-ops on already-clean connection", () => {
    const conn = makeConn();
    expect(() => cleanupConnection(conn)).not.toThrow();
  });
});

describe("scheduleReconnect", () => {
  afterEach(() => {
    // Clean up any scheduled timers
  });

  it("increments reconnectAttempt", () => {
    const conn = makeConn({ reconnectAttempt: 0 });
    scheduleReconnect(conn, () => {});
    expect(conn.reconnectAttempt).toBe(1);
    // Clean up timer
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  });

  it("sets reconnectTimer", () => {
    const conn = makeConn();
    scheduleReconnect(conn, () => {});
    expect(conn.reconnectTimer).not.toBeNull();
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  });

  it("does not schedule if timer already exists", () => {
    const existing = setTimeout(() => {}, 999999);
    const conn = makeConn({ reconnectTimer: existing, reconnectAttempt: 0 });
    scheduleReconnect(conn, () => {});
    expect(conn.reconnectAttempt).toBe(0); // not incremented
    expect(conn.reconnectTimer).toBe(existing); // unchanged
    clearTimeout(existing);
  });

  it("caps delay at RECONNECT_MAX_MS for high attempt counts", () => {
    const conn = makeConn({ reconnectAttempt: 100 });
    scheduleReconnect(conn, () => {});
    expect(conn.reconnectAttempt).toBe(101);
    expect(conn.reconnectTimer).not.toBeNull();
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  });
});
