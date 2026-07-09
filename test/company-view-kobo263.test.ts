import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-263 — a structured @tony/@human comment (tldr + ask, optional detail) renders
// tldr-prominent · ask clear · detail COLLAPSED (click-expand); a plain/legacy/agent comment
// still renders its text. The board is a single-file HTML+JS template (no runtime here), so
// pin the structural markers a refactor must not drop.
describe("company board view — kobo-263 structured comment render", () => {
  const html = companyHtml();

  test("branches on c.tldr: structured render vs plain text fallback", () => {
    expect(html).toContain("if (c.tldr)"); // structured path only when the fields are present
    expect(html).toContain("renderNoteBody(c.text"); // plain/legacy comments still render text
  });

  test("tldr prominent · ask clear · detail folded (details/summary)", () => {
    expect(html).toContain("cmt-tldr"); // the prominent 1-liner
    expect(html).toContain("cmt-ask"); // the ask line
    expect(html).toContain("el('details', 'cmt-detail')"); // detail is COLLAPSED by default (native disclosure)
    expect(html).toContain("renderNoteBody(c.detail"); // evidence rendered inside the fold
  });

  test("tldr/ask use textContent (escape-safe), not innerHTML", () => {
    // el(tag, cls, txt) sets textContent — the tldr/ask are plain, never innerHTML (XSS-safe)
    expect(html).toContain("el('div', 'cmt-tldr', c.tldr)");
  });
});
