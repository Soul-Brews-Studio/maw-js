/**
 * Tests for src/core/util/render-ambiguous.ts — renderAmbiguousMatch, buildRerunHint.
 * Pure formatting functions, zero side effects.
 */
import { describe, it, expect } from "bun:test";
import { renderAmbiguousMatch } from "../../src/core/util/render-ambiguous";
import { AmbiguousMatchError } from "../../src/core/runtime/find-window";

describe("renderAmbiguousMatch", () => {
  it("includes error line with query and count", () => {
    const err = new AmbiguousMatchError("neo", ["maw:0", "dev:1"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "hello"]);
    expect(result).toContain("'neo'");
    expect(result).toContain("2 candidates");
  });

  it("lists all candidates with bullet points", () => {
    const err = new AmbiguousMatchError("agent", ["maw:0", "dev:0", "test:0"]);
    const result = renderAmbiguousMatch(err, ["hey", "agent", "msg"]);
    expect(result).toContain("• maw:0");
    expect(result).toContain("• dev:0");
    expect(result).toContain("• test:0");
  });

  it("includes rerun hint section", () => {
    const err = new AmbiguousMatchError("neo", ["maw:0", "dev:1"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "hello"]);
    expect(result).toContain("rerun with one of:");
  });

  it("substitutes candidate into original argv for rerun hint", () => {
    const err = new AmbiguousMatchError("neo", ["maw:0"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "fix bug"]);
    expect(result).toContain('maw hey maw:0 "fix bug"');
  });

  it("falls back to generic hint when query not in argv", () => {
    const err = new AmbiguousMatchError("neo", ["maw:0"]);
    const result = renderAmbiguousMatch(err, ["send", "other-name"]);
    expect(result).toContain("maw send maw:0");
  });

  it("handles empty argv", () => {
    const err = new AmbiguousMatchError("x", ["a:0"]);
    const result = renderAmbiguousMatch(err, []);
    // Falls back: verb = undefined → "hey"
    expect(result).toContain("maw");
  });

  it("includes ANSI color codes", () => {
    const err = new AmbiguousMatchError("x", ["a:0"]);
    const result = renderAmbiguousMatch(err, ["hey", "x"]);
    expect(result).toContain("\x1b[31m"); // red
    expect(result).toContain("\x1b[36m"); // cyan
    expect(result).toContain("\x1b[0m");  // reset
  });
});
