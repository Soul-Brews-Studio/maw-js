import { describe, it, expect } from "bun:test";
import { AmbiguousMatchError } from "../src/core/runtime/find-window";
import { renderAmbiguousMatch } from "../src/core/util/render-ambiguous";

// #567 — the CLI must render AmbiguousMatchError as an actionable message,
// not a minified stack. These tests lock the essentials: each candidate on
// its own line, a "rerun with" hint per candidate, and query echoed in the
// primary line. We deliberately don't assert on ANSI codes — tests are
// brittle enough without encoding colour in string literals.

describe("renderAmbiguousMatch (#567)", () => {
  const err = new AmbiguousMatchError("mawjs-oracle", ["101-mawjs:0", "mawjs-view:0"]);
  const argv = ["hey", "mawjs-oracle", "hello"];
  const out = renderAmbiguousMatch(err, argv);

  it("includes the ambiguous query in the primary error line", () => {
    expect(out).toContain("'mawjs-oracle'");
    expect(out).toContain("matches 2 candidates");
  });

  it("lists each candidate on its own line", () => {
    expect(out).toContain("• 101-mawjs:0");
    expect(out).toContain("• mawjs-view:0");
  });

  it("emits a rerun hint per candidate, substituting the query", () => {
    expect(out).toContain("rerun with one of");
    expect(out).toContain("maw hey 101-mawjs:0");
    expect(out).toContain("maw hey mawjs-view:0");
    // Ambiguous query string must not reappear in any rerun hint.
    const hintLines = out.split("\n").filter(l => l.startsWith("  maw "));
    expect(hintLines.length).toBe(2);
    for (const h of hintLines) expect(h).not.toContain("mawjs-oracle");
  });

  it("falls back to a generic hint when argv doesn't contain the query", () => {
    const out2 = renderAmbiguousMatch(err, ["send", "someOtherThing", "msg"]);
    expect(out2).toContain("maw send 101-mawjs:0");
    expect(out2).toContain("maw send mawjs-view:0");
  });
});
