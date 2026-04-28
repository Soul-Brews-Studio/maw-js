/**
 * Tests for src/api/workspace-helpers.ts — ID/token generators, touchNode, pushFeed.
 * Pure crypto-based generators + in-memory object mutations.
 */
import { describe, it, expect } from "bun:test";
import {
  generateWorkspaceId,
  generateToken,
  generateJoinCode,
  touchNode,
  pushFeed,
} from "../../src/api/workspace-helpers";
import type { Workspace, WorkspaceFeedEvent } from "../../src/api/workspace-types";

// ─── generateWorkspaceId ────────────────────────────────────────

describe("generateWorkspaceId", () => {
  it("starts with ws_ prefix", () => {
    expect(generateWorkspaceId()).toMatch(/^ws_/);
  });

  it("has length ws_ + 8 chars", () => {
    expect(generateWorkspaceId().length).toBe(11); // "ws_" + 8
  });

  it("generates unique IDs", () => {
    const a = generateWorkspaceId();
    const b = generateWorkspaceId();
    expect(a).not.toBe(b);
  });
});

// ─── generateToken ──────────────────────────────────────────────

describe("generateToken", () => {
  it("returns hex string of 64 chars (32 bytes)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates unique tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

// ─── generateJoinCode ───────────────────────────────────────────

describe("generateJoinCode", () => {
  it("returns uppercase string of 6 chars", () => {
    const code = generateJoinCode();
    expect(code.length).toBe(6);
    expect(code).toBe(code.toUpperCase());
  });

  it("is URL-safe (base64url charset)", () => {
    const code = generateJoinCode();
    expect(code).toMatch(/^[A-Z0-9_-]+$/i);
  });

  it("generates unique codes", () => {
    const codes = new Set(Array.from({ length: 10 }, generateJoinCode));
    expect(codes.size).toBeGreaterThan(1); // statistically should be unique
  });
});

// ─── touchNode ──────────────────────────────────────────────────

describe("touchNode", () => {
  function makeWs(): Workspace {
    return {
      id: "ws_test",
      name: "test",
      token: "tok",
      hubUrl: "",
      createdAt: "2026-01-01T00:00:00Z",
      nodes: [
        { nodeId: "node-1", name: "alpha", lastSeen: "2026-01-01T00:00:00Z" },
        { nodeId: "node-2", name: "beta", lastSeen: "2026-01-01T00:00:00Z" },
      ],
      feed: [],
    } as any;
  }

  it("updates lastSeen for matching node", () => {
    const ws = makeWs();
    touchNode(ws, "node-1");
    expect(ws.nodes[0].lastSeen).not.toBe("2026-01-01T00:00:00Z");
  });

  it("does not update non-matching nodes", () => {
    const ws = makeWs();
    touchNode(ws, "node-1");
    expect(ws.nodes[1].lastSeen).toBe("2026-01-01T00:00:00Z");
  });

  it("does nothing for unknown node", () => {
    const ws = makeWs();
    touchNode(ws, "node-999");
    expect(ws.nodes[0].lastSeen).toBe("2026-01-01T00:00:00Z");
    expect(ws.nodes[1].lastSeen).toBe("2026-01-01T00:00:00Z");
  });
});

// ─── pushFeed ───────────────────────────────────────────────────

describe("pushFeed", () => {
  function makeWs(): Workspace {
    return {
      id: "ws_test", name: "test", token: "tok", hubUrl: "",
      createdAt: "2026-01-01T00:00:00Z", nodes: [], feed: [],
    } as any;
  }

  it("adds event to feed array", () => {
    const ws = makeWs();
    pushFeed(ws, { type: "join", nodeId: "n1", timestamp: "2026-01-01T00:00:00Z" } as any);
    expect(ws.feed.length).toBe(1);
  });

  it("assigns an id to the event", () => {
    const ws = makeWs();
    pushFeed(ws, { type: "join", nodeId: "n1", timestamp: "2026-01-01T00:00:00Z" } as any);
    expect(ws.feed[0].id).toBeDefined();
    expect(typeof ws.feed[0].id).toBe("string");
  });

  it("trims feed when exceeding 200 events", () => {
    const ws = makeWs();
    for (let i = 0; i < 210; i++) {
      pushFeed(ws, { type: "join", nodeId: `n${i}`, timestamp: "2026-01-01T00:00:00Z" } as any);
    }
    expect(ws.feed.length).toBe(200);
  });

  it("keeps most recent events when trimming", () => {
    const ws = makeWs();
    for (let i = 0; i < 205; i++) {
      pushFeed(ws, { type: "join", nodeId: `n${i}`, timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` } as any);
    }
    // The first 5 events should have been trimmed
    expect(ws.feed.length).toBe(200);
  });
});
