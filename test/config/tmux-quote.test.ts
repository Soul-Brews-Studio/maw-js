/**
 * Tests for q (shell-quote) from src/core/transport/tmux-types.ts.
 * Pure string quoting — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { q } from "../../src/core/transport/tmux-types";

describe("q (tmux shell-quote)", () => {
  it("leaves safe strings unquoted", () => {
    expect(q("hello")).toBe("hello");
    expect(q("foo-bar")).toBe("foo-bar");
    expect(q("path/to/file")).toBe("path/to/file");
    expect(q("file.txt")).toBe("file.txt");
    expect(q("host:3456")).toBe("host:3456");
    expect(q("under_score")).toBe("under_score");
  });

  it("quotes strings with spaces", () => {
    const result = q("hello world");
    expect(result).toContain("hello world");
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it("quotes strings with special characters", () => {
    expect(q("a;b")).toStartWith("'");
    expect(q("a&b")).toStartWith("'");
    expect(q("a|b")).toStartWith("'");
    expect(q("a$b")).toStartWith("'");
  });

  it("escapes single quotes in content", () => {
    const result = q("it's");
    expect(result).toContain("\\'");
  });

  it("converts numbers to string", () => {
    expect(q(42)).toBe("42");
    expect(q(0)).toBe("0");
  });

  it("handles empty string", () => {
    const result = q("");
    expect(result).toBe("''");
  });

  it("handles path-like strings without quoting", () => {
    expect(q("/usr/bin/tmux")).toBe("/usr/bin/tmux");
    expect(q("08-mawjs:0")).toBe("08-mawjs:0");
  });
});
