/**
 * Tests for src/commands/plugins/peers/impl.ts — validateAlias, validateUrl, formatList (pure functions).
 */
import { describe, it, expect } from "bun:test";
import { validateAlias, validateUrl, formatList } from "../../src/commands/plugins/peers/impl";
import type { Peer } from "../../src/commands/plugins/peers/store";

describe("validateAlias", () => {
  it("accepts valid alias", () => {
    expect(validateAlias("my-peer")).toBeNull();
  });

  it("accepts single char", () => {
    expect(validateAlias("a")).toBeNull();
  });

  it("accepts underscores", () => {
    expect(validateAlias("my_peer")).toBeNull();
  });

  it("accepts numeric start", () => {
    expect(validateAlias("1abc")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateAlias("")).not.toBeNull();
  });

  it("rejects uppercase", () => {
    expect(validateAlias("MyPeer")).not.toBeNull();
  });

  it("rejects starting with hyphen", () => {
    expect(validateAlias("-peer")).not.toBeNull();
  });

  it("rejects special chars", () => {
    expect(validateAlias("peer@host")).not.toBeNull();
  });

  it("rejects too long alias (33 chars)", () => {
    expect(validateAlias("a".repeat(33))).not.toBeNull();
  });

  it("accepts max length (32 chars)", () => {
    expect(validateAlias("a" + "b".repeat(31))).toBeNull();
  });
});

describe("validateUrl", () => {
  it("accepts http URL", () => {
    expect(validateUrl("http://localhost:3000")).toBeNull();
  });

  it("accepts https URL", () => {
    expect(validateUrl("https://peer.example.com")).toBeNull();
  });

  it("rejects ftp URL", () => {
    expect(validateUrl("ftp://files.example.com")).not.toBeNull();
  });

  it("rejects invalid URL", () => {
    expect(validateUrl("not-a-url")).not.toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateUrl("")).not.toBeNull();
  });
});

describe("formatList", () => {
  it("returns 'no peers' for empty array", () => {
    expect(formatList([])).toBe("no peers");
  });

  it("formats single peer with header", () => {
    const rows = [{
      alias: "dev",
      url: "http://localhost:3000",
      node: "mba",
      addedAt: "2026-01-01",
      lastSeen: "2026-01-02",
    }];
    const result = formatList(rows);
    expect(result).toContain("alias");
    expect(result).toContain("url");
    expect(result).toContain("dev");
    expect(result).toContain("mba");
  });

  it("shows dash for null node", () => {
    const rows = [{
      alias: "test",
      url: "http://example.com",
      node: null,
      addedAt: "2026-01-01",
      lastSeen: null,
    }];
    const result = formatList(rows);
    expect(result).toContain("-");
  });

  it("includes separator line", () => {
    const rows = [{
      alias: "a",
      url: "http://a.com",
      node: "n",
      addedAt: "2026-01-01",
      lastSeen: "2026-01-01",
    }];
    const lines = formatList(rows).split("\n");
    expect(lines.length).toBe(3); // header, separator, data
    expect(lines[1]).toMatch(/^-+/);
  });

  it("aligns columns", () => {
    const rows = [
      { alias: "short", url: "http://a.com", node: "n", addedAt: "2026-01-01", lastSeen: "2026-01-01" },
      { alias: "very-long-alias", url: "http://b.com", node: "node2", addedAt: "2026-01-01", lastSeen: "2026-01-02" },
    ];
    const lines = formatList(rows).split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 rows
  });

  it("shows nickname when present", () => {
    const rows = [{
      alias: "dev",
      url: "http://localhost:3000",
      node: "mba",
      addedAt: "2026-01-01",
      lastSeen: "2026-01-02",
      nickname: "My Dev Box",
    }];
    const result = formatList(rows);
    expect(result).toContain("My Dev Box");
  });
});
