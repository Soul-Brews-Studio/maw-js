import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-198 — board-card overflow: a long single pill (block-reason / parent-not-found
// carries free text, white-space:nowrap) had no width cap, so its min-content forced
// .col wide → the board grid blew past its track and text bled past the column edge.
// Fix is CSS-only: cap the pill at container width + ellipsis, and let the grid item
// (.col) shrink to its track. Layout-overflow itself needs a real engine — verified in
// a chrome render harness (real extracted <style> + a long-reason card): pre-fix pill
// overflow:visible spilled past the 150px column (board scrollWidth 1870); post-fix the
// pill clips to the column (clientWidth 102, colWidth 150). Here we pin the CSS rules on
// the REAL companyHtml() output so a rebase can't silently drop them.
// ponytail: the clamp is asserted by CSS markers, not a headless layout run (no jsdom in
//   repo). The chrome harness proof lives in the PR; re-run it if the board grid changes.
describe("company board view — kobo-198 card overflow clamp", () => {
  const html = companyHtml();

  test("a long pill clamps to its container (cap + ellipsis) instead of pushing the grid", () => {
    const pill = html.match(/\.pill \{[^}]*\}/)?.[0] ?? "";
    expect(pill).toContain("max-width:100%");
    expect(pill).toContain("overflow:hidden");
    expect(pill).toContain("text-overflow:ellipsis");
    expect(pill).toContain("white-space:nowrap"); // still a badge — nowrap, just capped
  });

  test(".col grid item can shrink to its track (min-width:0 — no content blowout)", () => {
    const col = html.match(/\.col \{[^}]*\}/)?.[0] ?? "";
    expect(col).toContain("min-width:0");
  });

  test("the note-preview one-liner keeps its own clamp (unchanged)", () => {
    expect(html).toContain(".task .t-note-latest {");
    const note = html.match(/\.task \.t-note-latest \{[^}]*\}/)?.[0] ?? "";
    expect(note).toContain("overflow:hidden");
    expect(note).toContain("text-overflow:ellipsis");
    expect(note).toContain("white-space:nowrap");
  });
});
