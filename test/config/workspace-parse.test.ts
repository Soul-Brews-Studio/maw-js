/**
 * Tests for _parseCreate, _parseJoin, _parseShareAgents from
 * src/commands/plugins/workspace/index.ts.
 * Pure arg parsing — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { _parseCreate, _parseJoin, _parseShareAgents } from "../../src/commands/plugins/workspace/index";

describe("_parseCreate", () => {
  it("parses name from positional arg", () => {
    const result = _parseCreate(["create", "my-workspace"]);
    expect(result.name).toBe("my-workspace");
    expect(result.hub).toBeUndefined();
  });

  it("parses --hub flag", () => {
    const result = _parseCreate(["create", "ws1", "--hub", "wss://hub.example.com"]);
    expect(result.name).toBe("ws1");
    expect(result.hub).toBe("wss://hub.example.com");
  });

  it("returns undefined name when empty", () => {
    const result = _parseCreate(["create"]);
    expect(result.name).toBeUndefined();
  });
});

describe("_parseJoin", () => {
  it("parses code from positional arg", () => {
    const result = _parseJoin(["join", "ABC123"]);
    expect(result.code).toBe("ABC123");
    expect(result.hub).toBeUndefined();
  });

  it("parses --hub flag", () => {
    const result = _parseJoin(["join", "XYZ", "--hub", "wss://hub.example.com"]);
    expect(result.code).toBe("XYZ");
    expect(result.hub).toBe("wss://hub.example.com");
  });

  it("returns undefined code when empty", () => {
    const result = _parseJoin(["join"]);
    expect(result.code).toBeUndefined();
  });
});

describe("_parseShareAgents", () => {
  it("parses agent names", () => {
    const result = _parseShareAgents(["share", "neo", "pulse"]);
    expect(result.agents).toEqual(["neo", "pulse"]);
    expect(result.wsId).toBeUndefined();
  });

  it("parses --workspace flag", () => {
    const result = _parseShareAgents(["share", "--workspace", "ws-123", "neo"]);
    expect(result.wsId).toBe("ws-123");
    expect(result.agents).toContain("neo");
  });

  it("parses --ws alias", () => {
    const result = _parseShareAgents(["share", "--ws", "ws-123", "neo"]);
    expect(result.wsId).toBe("ws-123");
  });

  it("returns empty agents when none given", () => {
    const result = _parseShareAgents(["share"]);
    expect(result.agents).toEqual([]);
  });
});
