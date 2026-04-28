/**
 * Tests for src/core/util/render-ambiguous.ts — renderAmbiguousMatch.
 * Pure string formatting: produces CLI error message from AmbiguousMatchError.
 */
import { describe, it, expect } from "bun:test";
import { renderAmbiguousMatch } from "../../src/core/util/render-ambiguous";
import { AmbiguousMatchError } from "../../src/core/runtime/find-window";

describe("renderAmbiguousMatch", () => {
  it("includes error header with query and count", () => {
    const err = new AmbiguousMatchError("neo", ["neo-main", "neo-dev"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "hello"]);
    expect(result).toContain("'neo' matches 2 candidates:");
  });

  it("lists all candidates with bullet points", () => {
    const err = new AmbiguousMatchError("neo", ["neo-main", "neo-dev"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo"]);
    expect(result).toContain("• neo-main");
    expect(result).toContain("• neo-dev");
  });

  it("includes rerun hints", () => {
    const err = new AmbiguousMatchError("neo", ["neo-main", "neo-dev"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "hello"]);
    expect(result).toContain("rerun with one of:");
    expect(result).toContain("maw hey neo-main hello");
    expect(result).toContain("maw hey neo-dev hello");
  });

  it("substitutes query in argv for rerun hint", () => {
    const err = new AmbiguousMatchError("boom", ["boom-main", "boom-test"]);
    const result = renderAmbiguousMatch(err, ["send", "boom", "msg"]);
    expect(result).toContain("maw send boom-main msg");
    expect(result).toContain("maw send boom-test msg");
  });

  it("falls back to verb + candidate when query not in argv", () => {
    const err = new AmbiguousMatchError("neo", ["neo-main", "neo-dev"]);
    const result = renderAmbiguousMatch(err, ["hey", "aliased-neo"]);
    expect(result).toContain('maw hey neo-main "..."');
    expect(result).toContain('maw hey neo-dev "..."');
  });

  it("handles single candidate", () => {
    const err = new AmbiguousMatchError("x", ["x-only"]);
    const result = renderAmbiguousMatch(err, ["hey", "x"]);
    expect(result).toContain("1 candidates:");
    expect(result).toContain("• x-only");
  });

  it("handles empty argv fallback", () => {
    const err = new AmbiguousMatchError("neo", ["neo-a"]);
    const result = renderAmbiguousMatch(err, []);
    // Falls back to verb=undefined → "hey"
    expect(result).toContain("maw hey neo-a");
  });

  it("quotes args with spaces in rerun hint", () => {
    const err = new AmbiguousMatchError("neo", ["neo-main"]);
    const result = renderAmbiguousMatch(err, ["hey", "neo", "hello world"]);
    expect(result).toContain('"hello world"');
  });
});
