import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-201 — board-card note-preview vertical clamp. The Blocked lane shows every
// note in full on the card face (kobo-199 triage). A long/multi-line note rendered
// pre-wrap with no height cap → a full-height "note wall" on the board (Tony:
// "ข้อมูลเยอะเกิน"). Fix is CSS-only: line-clamp each Blocked note to ~4 lines on the
// board FACE; the full text still renders (data untouched) and the modal shows it in
// full. Layout itself needs a real engine — verified in a chrome render harness (long
// blocked note → clamped ~4 lines on the board card, full in the modal). Here we pin
// the CSS markers on the REAL companyHtml() output so a rebase can't drop them.
describe("company board view — kobo-201 note-preview vertical clamp", () => {
  const html = companyHtml();

  test("each Blocked-lane board note clamps to N lines (vertical) with ellipsis", () => {
    const note = html.match(/\.task \.t-notes-full \.t-note \{[^}]*\}/)?.[0] ?? "";
    expect(note).toContain("-webkit-line-clamp:4");
    expect(note).toContain("-webkit-box-orient:vertical");
    expect(note).toContain("overflow:hidden");
    expect(note).toContain("display:-webkit-box");
    // full text is still preserved for reflow inside the clamp box (not truncated data)
    expect(note).toContain("white-space:pre-wrap");
  });

  test("the modal note (#detail-notes .note) is NOT board-clamped — full trail stays", () => {
    // scope guard: the board clamp must live only under .task, never the modal selector
    const modalNote = html.match(/#detail-notes \.note \{[^}]*\}/)?.[0] ?? "";
    expect(modalNote).not.toContain("-webkit-line-clamp");
  });
});
