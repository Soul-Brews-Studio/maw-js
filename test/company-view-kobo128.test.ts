import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-128 — board mention/reply queue + parent-badge (Phase A §1 B). The board is
// a single-file HTML+JS template with no runtime here, so pin the structural markers
// the two features add so a refactor that drops one is visible.
describe("company board view — kobo-128 mention/reply + parent-badge", () => {
  const html = companyHtml();

  test("mentions queue at the board head + append-only reply", () => {
    expect(html).toContain('id="mentions-bar"'); // the queue container, above the board
    expect(html).toContain("function renderMentions");
    expect(html).toContain("mention-reply-btn");
    // reply is append-note ONLY — the single write path from C; no state/assignee/archive
    expect(html).toContain("'/api/tasks/note'");
  });

  test("mentions logic mirrors the CLI (mentionKey/parseMentions/pendingMentions)", () => {
    expect(html).toContain("function mentionKey");
    expect(html).toContain("function parseMentions");
    expect(html).toContain("function pendingMentions");
    // @tony/@human collapse to one queue (head Q3)
    expect(html).toContain("HUMAN_ALIASES");
    // the board head shows Tony's queue
    expect(html).toContain("m.who === 'tony'");
  });

  test("parent-badge: open vs answered ask-subcards", () => {
    expect(html).toContain("function questionSubcards");
    expect(html).toContain("q-open"); // ⧉ N open →tony
    expect(html).toContain("q-answered"); // ⧉ answered ✓
    expect(html).toContain("open →tony");
  });
});
