/**
 * Tests for normalizeWorkspace from src/commands/shared/workspace-store.ts.
 * Pure function: takes raw data, returns typed WorkspaceConfig or null.
 */
import { describe, it, expect } from "bun:test";
import { normalizeWorkspace } from "../../src/commands/shared/workspace-store";

describe("normalizeWorkspace", () => {
  it("normalizes a full workspace object", () => {
    const raw = {
      id: "ws-1",
      name: "My Workspace",
      hubUrl: "http://hub:3000",
      joinCode: "ABC123",
      sharedAgents: ["neo", "spark"],
      joinedAt: "2026-04-01T00:00:00Z",
      lastStatus: "connected",
    };
    const ws = normalizeWorkspace(raw);
    expect(ws).not.toBeNull();
    expect(ws!.id).toBe("ws-1");
    expect(ws!.name).toBe("My Workspace");
    expect(ws!.hubUrl).toBe("http://hub:3000");
    expect(ws!.sharedAgents).toEqual(["neo", "spark"]);
    expect(ws!.lastStatus).toBe("connected");
  });

  it("returns null for null input", () => {
    expect(normalizeWorkspace(null)).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(normalizeWorkspace("string")).toBeNull();
    expect(normalizeWorkspace(42)).toBeNull();
  });

  it("returns null for missing id", () => {
    expect(normalizeWorkspace({ name: "test" })).toBeNull();
  });

  it("returns null for empty id", () => {
    expect(normalizeWorkspace({ id: "" })).toBeNull();
  });

  it("defaults name to (unnamed)", () => {
    const ws = normalizeWorkspace({ id: "x" });
    expect(ws!.name).toBe("(unnamed)");
  });

  it("defaults hubUrl to empty string", () => {
    const ws = normalizeWorkspace({ id: "x" });
    expect(ws!.hubUrl).toBe("");
  });

  it("defaults sharedAgents to empty array", () => {
    const ws = normalizeWorkspace({ id: "x" });
    expect(ws!.sharedAgents).toEqual([]);
  });

  it("filters non-string sharedAgents", () => {
    const ws = normalizeWorkspace({ id: "x", sharedAgents: ["neo", 42, null, "spark"] });
    expect(ws!.sharedAgents).toEqual(["neo", "spark"]);
  });

  it("falls back joinedAt to createdAt (legacy)", () => {
    const ws = normalizeWorkspace({ id: "x", createdAt: "2026-03-30" });
    expect(ws!.joinedAt).toBe("2026-03-30");
  });

  it("prefers joinedAt over createdAt", () => {
    const ws = normalizeWorkspace({ id: "x", joinedAt: "2026-04-01", createdAt: "2026-03-30" });
    expect(ws!.joinedAt).toBe("2026-04-01");
  });

  it("whitelists lastStatus values", () => {
    expect(normalizeWorkspace({ id: "x", lastStatus: "connected" })!.lastStatus).toBe("connected");
    expect(normalizeWorkspace({ id: "x", lastStatus: "disconnected" })!.lastStatus).toBe("disconnected");
    expect(normalizeWorkspace({ id: "x", lastStatus: "invalid" })!.lastStatus).toBeUndefined();
  });
});
