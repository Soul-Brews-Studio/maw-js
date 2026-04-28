/**
 * Tests for handleMessage from src/transports/hub-connection.ts — message dispatch.
 * handleMessage is pure enough to test: takes all deps as args, only side effects are
 * console.log and mutating conn.remoteAgents (a Set we fabricate).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { handleMessage } from "../../src/transports/hub-connection";
import type { HubConnection } from "../../src/transports/hub-connection";

function makeConn(overrides: Partial<HubConnection> = {}): HubConnection {
  return {
    config: { id: "ws-test", hubUrl: "ws://localhost", token: "tok", sharedAgents: [], ...overrides.config as any },
    ws: null,
    connected: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(),
    ...overrides,
  };
}

describe("handleMessage", () => {
  let conn: HubConnection;
  let msgHandlers: Set<(msg: any) => void>;
  let presenceHandlers: Set<(p: any) => void>;
  let feedHandlers: Set<(e: any) => void>;

  beforeEach(() => {
    conn = makeConn();
    msgHandlers = new Set();
    presenceHandlers = new Set();
    feedHandlers = new Set();
  });

  it("handles auth-ok and sets remoteAgents", () => {
    const raw = JSON.stringify({ type: "auth-ok", workspaceId: "ws1", agents: ["alice", "bob"] });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);
    expect(conn.remoteAgents.has("alice")).toBe(true);
    expect(conn.remoteAgents.has("bob")).toBe(true);
    expect(conn.remoteAgents.size).toBe(2);
  });

  it("handles auth-ok without agents array", () => {
    const raw = JSON.stringify({ type: "auth-ok", workspaceId: "ws1" });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);
    // remoteAgents stays as original empty set
    expect(conn.remoteAgents.size).toBe(0);
  });

  it("dispatches message to msgHandlers", () => {
    const received: any[] = [];
    msgHandlers.add((msg) => received.push(msg));

    const raw = JSON.stringify({ type: "message", from: "alice", to: "bob", body: "hi", timestamp: 1000 });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("alice");
    expect(received[0].to).toBe("bob");
    expect(received[0].body).toBe("hi");
    expect(received[0].transport).toBe("hub");
  });

  it("uses defaults for missing message fields", () => {
    const received: any[] = [];
    msgHandlers.add((msg) => received.push(msg));

    const raw = JSON.stringify({ type: "message" });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);

    expect(received[0].from).toBe("unknown");
    expect(received[0].to).toBe("unknown");
    expect(received[0].body).toBe("");
  });

  it("dispatches to multiple msgHandlers", () => {
    let count = 0;
    msgHandlers.add(() => count++);
    msgHandlers.add(() => count++);

    handleMessage(conn, JSON.stringify({ type: "message" }), msgHandlers, presenceHandlers, feedHandlers);
    expect(count).toBe(2);
  });

  it("handles presence with agents", () => {
    const received: any[] = [];
    presenceHandlers.add((p) => received.push(p));

    const raw = JSON.stringify({
      type: "presence",
      agents: [
        { name: "alice", host: "h1", status: "busy" },
        { name: "bob", nodeId: "n2" },
      ],
      timestamp: 5000,
    });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);

    expect(received).toHaveLength(2);
    expect(received[0].oracle).toBe("alice");
    expect(received[0].host).toBe("h1");
    expect(received[0].status).toBe("busy");
    expect(received[1].oracle).toBe("bob");
    expect(received[1].host).toBe("n2"); // falls back to nodeId
    expect(received[1].status).toBe("ready"); // default
    // adds to remoteAgents
    expect(conn.remoteAgents.has("alice")).toBe(true);
    expect(conn.remoteAgents.has("bob")).toBe(true);
  });

  it("skips presence without agents array", () => {
    const received: any[] = [];
    presenceHandlers.add((p) => received.push(p));

    handleMessage(conn, JSON.stringify({ type: "presence" }), msgHandlers, presenceHandlers, feedHandlers);
    expect(received).toHaveLength(0);
  });

  it("handles node-left and removes agents from remoteAgents", () => {
    conn.remoteAgents = new Set(["alice", "bob", "carol"]);
    const raw = JSON.stringify({ type: "node-left", nodeId: "n1", agents: ["alice", "bob"] });
    handleMessage(conn, raw, msgHandlers, presenceHandlers, feedHandlers);

    expect(conn.remoteAgents.has("alice")).toBe(false);
    expect(conn.remoteAgents.has("bob")).toBe(false);
    expect(conn.remoteAgents.has("carol")).toBe(true);
  });

  it("handles node-left without agents array", () => {
    conn.remoteAgents = new Set(["alice"]);
    handleMessage(conn, JSON.stringify({ type: "node-left", nodeId: "n1" }), msgHandlers, presenceHandlers, feedHandlers);
    // Should not crash, remoteAgents unchanged
    expect(conn.remoteAgents.has("alice")).toBe(true);
  });

  it("handles feed events", () => {
    const received: any[] = [];
    feedHandlers.add((e) => received.push(e));

    const event = { kind: "commit", oracle: "alice", ts: 1000 };
    handleMessage(conn, JSON.stringify({ type: "feed", event }), msgHandlers, presenceHandlers, feedHandlers);

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("commit");
  });

  it("skips feed without event field", () => {
    const received: any[] = [];
    feedHandlers.add((e) => received.push(e));

    handleMessage(conn, JSON.stringify({ type: "feed" }), msgHandlers, presenceHandlers, feedHandlers);
    expect(received).toHaveLength(0);
  });

  it("ignores unknown message types", () => {
    // Should not throw
    expect(() =>
      handleMessage(conn, JSON.stringify({ type: "unknown-future-type" }), msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("ignores malformed JSON", () => {
    expect(() =>
      handleMessage(conn, "this is not json{{{", msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("ignores empty string", () => {
    expect(() =>
      handleMessage(conn, "", msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("handles node-joined without crashing", () => {
    expect(() =>
      handleMessage(conn, JSON.stringify({ type: "node-joined", nodeId: "new-node" }), msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("handles error type without crashing", () => {
    expect(() =>
      handleMessage(conn, JSON.stringify({ type: "error", message: "bad auth" }), msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("handles error with reason field", () => {
    expect(() =>
      handleMessage(conn, JSON.stringify({ type: "error", reason: "rate limited" }), msgHandlers, presenceHandlers, feedHandlers)
    ).not.toThrow();
  });

  it("presence uses defaults for missing agent fields", () => {
    const received: any[] = [];
    presenceHandlers.add((p) => received.push(p));

    handleMessage(conn, JSON.stringify({
      type: "presence",
      agents: [{ }],
    }), msgHandlers, presenceHandlers, feedHandlers);

    expect(received[0].oracle).toBe("unknown");
    expect(received[0].host).toBe("remote");
    expect(received[0].status).toBe("ready");
  });
});
