/**
 * Tests for src/core/transport/tmux-types.ts — q (shell-quote).
 * Pure string helper.
 */
import { describe, it, expect } from "bun:test";
import { q } from "../../src/core/transport/tmux-types";

describe("q (shell-quote)", () => {
  it("passes safe strings unchanged", () => {
    expect(q("hello")).toBe("hello");
    expect(q("maw:0")).toBe("maw:0");
    expect(q("path/to/file")).toBe("path/to/file");
    expect(q("a-b_c.d")).toBe("a-b_c.d");
  });

  it("passes numbers unchanged", () => {
    expect(q(42)).toBe("42");
    expect(q(0)).toBe("0");
  });

  it("wraps strings with spaces in single quotes", () => {
    expect(q("hello world")).toBe("'hello world'");
  });

  it("wraps strings with special chars", () => {
    expect(q("foo;bar")).toBe("'foo;bar'");
    expect(q("a&b")).toBe("'a&b'");
    expect(q("$HOME")).toBe("'$HOME'");
  });

  it("escapes inner single quotes", () => {
    expect(q("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(q("")).toBe("''");
  });

  it("handles string with only special chars", () => {
    expect(q("!@#")).toBe("'!@#'");
  });
});
