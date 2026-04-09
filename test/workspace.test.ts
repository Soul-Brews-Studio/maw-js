import { describe, test, expect } from "bun:test";
import { normalizeWorkspace } from "../src/commands/workspace";

describe("normalizeWorkspace", () => {
  test("returns null for null", () => {
    expect(normalizeWorkspace(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(normalizeWorkspace(undefined)).toBeNull();
  });

  test("returns null for non-object", () => {
    expect(normalizeWorkspace("string")).toBeNull();
    expect(normalizeWorkspace(42)).toBeNull();
    expect(normalizeWorkspace([])).toBeNull();
  });

  test("returns null when id is missing", () => {
    expect(normalizeWorkspace({ name: "x" })).toBeNull();
  });

  test("returns null when id is empty string", () => {
    expect(normalizeWorkspace({ id: "" })).toBeNull();
  });

  test("returns null when id is not a string", () => {
    expect(normalizeWorkspace({ id: 42 })).toBeNull();
  });

  test("normalizes proper client schema unchanged", () => {
    const proper = {
      id: "ws_abc",
      name: "test",
      hubUrl: "http://white.wg:3456",
      joinCode: "ABCDEF",
      sharedAgents: ["pulse", "hermes"],
      joinedAt: "2026-04-08T05:00:00+07:00",
      lastStatus: "connected" as const,
    };
    expect(normalizeWorkspace(proper)).toEqual(proper);
  });

  test("normalizes legacy server schema with createdAt fallback for joinedAt", () => {
    const legacy = {
      id: "ws_13e5221d",
      name: "xxx",
      token: "b0bb...",
      joinCode: "NFWW1A",
      joinCodeExpiresAt: 1774962397419,
      createdAt: "2026-03-30T13:06:37.419Z",
      creatorNodeId: "white",
      nodes: [{ nodeId: "white", joinedAt: "2026-03-30T13:06:37.419Z" }],
      agents: [],
      feed: [{ nodeId: "white", type: "workspace.created", message: "..." }],
    };
    const result = normalizeWorkspace(legacy);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ws_13e5221d");
    expect(result!.name).toBe("xxx");
    expect(result!.hubUrl).toBe(""); // missing → empty string default
    expect(result!.sharedAgents).toEqual([]); // missing → empty array default
    expect(result!.joinedAt).toBe("2026-03-30T13:06:37.419Z"); // fell back to createdAt
    expect(result!.joinCode).toBe("NFWW1A"); // preserved
    expect(result!.lastStatus).toBeUndefined(); // missing → undefined
  });

  test("defaults sharedAgents to empty array when missing", () => {
    const result = normalizeWorkspace({ id: "ws_x", name: "test" });
    expect(result!.sharedAgents).toEqual([]);
  });

  test("filters non-string entries from sharedAgents", () => {
    const result = normalizeWorkspace({
      id: "ws_x",
      name: "test",
      sharedAgents: ["pulse", 42, null, "hermes", {}],
    });
    expect(result!.sharedAgents).toEqual(["pulse", "hermes"]);
  });

  test("rejects sharedAgents that is not an array", () => {
    const result = normalizeWorkspace({
      id: "ws_x",
      name: "test",
      sharedAgents: "not-an-array",
    });
    expect(result!.sharedAgents).toEqual([]);
  });

  test("defaults name to (unnamed) when missing", () => {
    const result = normalizeWorkspace({ id: "ws_x" });
    expect(result!.name).toBe("(unnamed)");
  });

  test("defaults hubUrl to empty string when missing", () => {
    const result = normalizeWorkspace({ id: "ws_x", name: "test" });
    expect(result!.hubUrl).toBe("");
  });

  test("defaults joinedAt to empty string when both joinedAt and createdAt missing", () => {
    const result = normalizeWorkspace({ id: "ws_x", name: "test" });
    expect(result!.joinedAt).toBe("");
  });

  test("prefers joinedAt over createdAt when both present", () => {
    const result = normalizeWorkspace({
      id: "ws_x",
      name: "test",
      joinedAt: "2026-04-08T00:00:00Z",
      createdAt: "2026-03-30T00:00:00Z",
    });
    expect(result!.joinedAt).toBe("2026-04-08T00:00:00Z");
  });

  test("whitelists lastStatus to known values only", () => {
    expect(normalizeWorkspace({ id: "ws_x", lastStatus: "connected" })!.lastStatus).toBe("connected");
    expect(normalizeWorkspace({ id: "ws_x", lastStatus: "disconnected" })!.lastStatus).toBe("disconnected");
    expect(normalizeWorkspace({ id: "ws_x", lastStatus: "weird" })!.lastStatus).toBeUndefined();
    expect(normalizeWorkspace({ id: "ws_x", lastStatus: 42 })!.lastStatus).toBeUndefined();
  });

  test("the exact 4 stale files from #194 all normalize without crashing", () => {
    // Real shapes from ~/.config/maw/workspaces/ on white as of 2026-04-08
    const stale = [
      { id: "ws_13e5221d", name: "xxx", token: "...", joinCode: "NFWW1A", createdAt: "2026-03-30T13:06:37.419Z", creatorNodeId: "white", nodes: [], agents: [], feed: [] },
      { id: "ws_1b3271b9", name: "xxxxxxxxxxx", token: "...", joinCode: "ULEU5W", createdAt: "2026-03-30T13:49:22.523Z", creatorNodeId: "white", nodes: [], agents: [], feed: [] },
      { id: "ws_576a277a", name: "NAT", token: "...", joinCode: "E9C1OQ", createdAt: "2026-03-30T13:55:58.716Z", creatorNodeId: "white.local", nodes: [], agents: [], feed: [] },
      { id: "ws_bec9cb60", name: "xxxxxxxxxxx", token: "...", joinCode: "JVLTPG", createdAt: "2026-03-30T13:49:29.251Z", creatorNodeId: "white", nodes: [], agents: [], feed: [] },
    ];
    const normalized = stale.map(normalizeWorkspace);
    expect(normalized.every(ws => ws !== null)).toBe(true);
    expect(normalized.map(ws => ws!.id)).toEqual(["ws_13e5221d", "ws_1b3271b9", "ws_576a277a", "ws_bec9cb60"]);
    // Each must have safe defaults so cmdWorkspaceLs won't crash
    for (const ws of normalized) {
      expect(Array.isArray(ws!.sharedAgents)).toBe(true);
      expect(typeof ws!.hubUrl).toBe("string");
      expect(typeof ws!.joinedAt).toBe("string");
    }
  });
});
