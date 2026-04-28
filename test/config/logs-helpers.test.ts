/**
 * Tests for src/api/logs-helpers.ts — agentFromDir.
 * Pure string parsing, no filesystem access needed.
 */
import { describe, it, expect } from "bun:test";
import { agentFromDir } from "../../src/api/logs-helpers";

describe("agentFromDir", () => {
  it("extracts agent name after known org prefix (Soul-Brews-Studio)", () => {
    expect(agentFromDir("-home-nat-Code-Soul-Brews-Studio-neo-oracle")).toBe("neo-oracle");
  });

  it("extracts agent name after known org prefix (laris-co)", () => {
    expect(agentFromDir("-home-user-ghq-laris-co-spark-oracle")).toBe("spark-oracle");
  });

  it("extracts agent name after known org prefix (nazt)", () => {
    expect(agentFromDir("-home-user-ghq-nazt-my-bot")).toBe("my-bot");
  });

  it("falls back to last 2 parts for unknown org", () => {
    expect(agentFromDir("-home-user-ghq-unknown-org-cool-agent")).toBe("cool-agent");
  });

  it("handles single-part dir name", () => {
    expect(agentFromDir("simple")).toBe("simple");
  });

  it("handles two-part dir name", () => {
    expect(agentFromDir("my-agent")).toBe("my-agent");
  });
});
