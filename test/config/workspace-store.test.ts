/**
 * Tests for src/commands/shared/workspace-store.ts — normalizeWorkspace (pure),
 * configPath, and CRUD with MAW_CONFIG_DIR override.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeWorkspace,
  configPath,
  WORKSPACES_DIR,
} from "../../src/commands/shared/workspace-store";

describe("normalizeWorkspace", () => {
  it("returns null for null input", () => {
    expect(normalizeWorkspace(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(normalizeWorkspace("string")).toBeNull();
    expect(normalizeWorkspace(42)).toBeNull();
    expect(normalizeWorkspace(true)).toBeNull();
  });

  it("returns null for missing id", () => {
    expect(normalizeWorkspace({ name: "test" })).toBeNull();
  });

  it("returns null for empty id", () => {
    expect(normalizeWorkspace({ id: "" })).toBeNull();
  });

  it("normalizes minimal valid input", () => {
    const result = normalizeWorkspace({ id: "ws-1" });
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ws-1");
    expect(result!.name).toBe("(unnamed)");
    expect(result!.hubUrl).toBe("");
    expect(result!.sharedAgents).toEqual([]);
    expect(result!.joinedAt).toBe("");
  });

  it("preserves all fields from complete input", () => {
    const input = {
      id: "ws-1",
      name: "Test Workspace",
      hubUrl: "https://hub.example.com",
      joinCode: "abc123",
      sharedAgents: ["spark", "forge"],
      joinedAt: "2026-01-01T00:00:00Z",
      lastStatus: "connected",
    };
    const result = normalizeWorkspace(input);
    expect(result!.name).toBe("Test Workspace");
    expect(result!.hubUrl).toBe("https://hub.example.com");
    expect(result!.joinCode).toBe("abc123");
    expect(result!.sharedAgents).toEqual(["spark", "forge"]);
    expect(result!.lastStatus).toBe("connected");
  });

  it("falls back joinedAt to createdAt", () => {
    const result = normalizeWorkspace({
      id: "ws-1",
      createdAt: "2026-03-30T12:00:00Z",
    });
    expect(result!.joinedAt).toBe("2026-03-30T12:00:00Z");
  });

  it("prefers joinedAt over createdAt", () => {
    const result = normalizeWorkspace({
      id: "ws-1",
      joinedAt: "2026-04-01T00:00:00Z",
      createdAt: "2026-03-30T00:00:00Z",
    });
    expect(result!.joinedAt).toBe("2026-04-01T00:00:00Z");
  });

  it("filters non-string sharedAgents", () => {
    const result = normalizeWorkspace({
      id: "ws-1",
      sharedAgents: ["spark", 42, null, "forge", true],
    });
    expect(result!.sharedAgents).toEqual(["spark", "forge"]);
  });

  it("defaults sharedAgents to empty array for non-array", () => {
    const result = normalizeWorkspace({
      id: "ws-1",
      sharedAgents: "not an array",
    });
    expect(result!.sharedAgents).toEqual([]);
  });

  it("whitelists lastStatus to connected/disconnected", () => {
    expect(normalizeWorkspace({ id: "ws-1", lastStatus: "connected" })!.lastStatus).toBe("connected");
    expect(normalizeWorkspace({ id: "ws-1", lastStatus: "disconnected" })!.lastStatus).toBe("disconnected");
    expect(normalizeWorkspace({ id: "ws-1", lastStatus: "unknown" })!.lastStatus).toBeUndefined();
    expect(normalizeWorkspace({ id: "ws-1", lastStatus: 42 })!.lastStatus).toBeUndefined();
  });

  it("defaults name for non-string", () => {
    const result = normalizeWorkspace({ id: "ws-1", name: 42 });
    expect(result!.name).toBe("(unnamed)");
  });

  it("defaults hubUrl for non-string", () => {
    const result = normalizeWorkspace({ id: "ws-1", hubUrl: null });
    expect(result!.hubUrl).toBe("");
  });

  it("omits joinCode when not a string", () => {
    const result = normalizeWorkspace({ id: "ws-1", joinCode: 123 });
    expect(result!.joinCode).toBeUndefined();
  });
});

describe("configPath", () => {
  it("returns path ending with .json", () => {
    expect(configPath("ws-1")).toMatch(/\.json$/);
  });

  it("includes workspace id in path", () => {
    expect(configPath("my-workspace")).toContain("my-workspace");
  });

  it("is under WORKSPACES_DIR", () => {
    expect(configPath("ws-1").startsWith(WORKSPACES_DIR)).toBe(true);
  });
});
