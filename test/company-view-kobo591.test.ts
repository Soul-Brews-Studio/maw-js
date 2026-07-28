import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";
import { visible } from "../src/core/worklog/render";

// kobo-591 — the web board's client-side renderTimeline filtered ONLY 'idle'
// (kobo-109), while the CLI's own renderTimeline (src/core/worklog/render.ts)
// filters 'idle'/'away'/'back' (mawjs-3, kobo-120) — a second silent web-vs-CLI
// drift point, same failure class kobo-580 already hit once tonight. Fixed by
// injecting render.ts's `visible()` verbatim via `.toString()` (same
// single-source pattern as escapeHtml/mdToHtml, kobo-396) instead of hand-typing
// a second copy of the filter list — a copy is exactly what drifted last time.
describe("company board view — kobo-591 worklog filter parity with the CLI", () => {
  const html = companyHtml();

  // kobo-445's own scar: a test that only asserts "the source contains this
  // string" stays green even if the function is mutated into a no-op (the
  // filter list quietly narrowed back to idle-only, say). Extract the REAL
  // injected function from the served HTML and call it — `visible` has zero
  // free variables (no DOM), so no stubbing is needed, unlike kobo-445's `load`.
  function extractVisible(src: string): (entries: Array<{ kind: string }>) => Array<{ kind: string }> {
    const start = src.indexOf("function visible(entries)");
    const end = src.indexOf("function renderTimeline(entries)");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("extractVisible: markers not found — the visible()/renderTimeline() boundary text changed, update this test's markers");
    }
    const body = src.slice(start, end);
    const factory = new Function(`${body}\nreturn visible;`);
    return factory();
  }

  test("the injected visible() is present and is the SAME function body as render.ts's real export — not a hand-copy", () => {
    expect(html).toContain("function visible(entries)");
    // the injected source and the real server-side function must be byte-identical
    // (proves .toString()-injection actually happened, not a parallel definition)
    expect(html).toContain(visible.toString().replace(/^export /, ""));
  });

  test("extracted visible() behaviorally drops idle/away/back and keeps everything else — mutation-provable, not a string-pin", () => {
    const clientVisible = extractVisible(html);
    const entries = [
      { kind: "tool" },
      { kind: "idle" },
      { kind: "conversation" },
      { kind: "away" },
      { kind: "pr-merged" },
      { kind: "back" },
    ];
    const kept = clientVisible(entries).map((e) => e.kind);
    expect(kept).toEqual(["tool", "conversation", "pr-merged"]);
  });

  test("renderTimeline is wired to CALL visible(), not just have it defined nearby", () => {
    const rtStart = html.indexOf("function renderTimeline(entries)");
    const rtEnd = html.indexOf("function relTime");
    expect(rtStart).toBeGreaterThan(-1);
    expect(rtEnd).toBeGreaterThan(rtStart);
    const renderTimelineSrc = html.slice(rtStart, rtEnd);
    expect(renderTimelineSrc).toContain("entries = visible(entries || [])");
  });

  test("client <script> parses as valid browser JS (backtick-trap guard, kobo-588's exact class)", () => {
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});
