import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-238 — the @mentions panel becomes a lightweight localStorage read-tracker
// (collapse-default, "read all", per-row mark-read; hides at 0 unread). No backend
// read-state — the board is a single-file HTML+JS template with no runtime here, so
// pin the structural markers a refactor must not silently drop.
describe("company board view — kobo-238 mentions read-tracker", () => {
  const html = companyHtml();

  test("read-state lives in localStorage only (no backend), keyed by cardId#commentId", () => {
    expect(html).toContain("function loadMentionsRead");
    expect(html).toContain("function saveMentionsRead");
    expect(html).toContain("'maw-company-mentions-read'"); // the localStorage container
    expect(html).toContain("function mentionReadKey");
    expect(html).toContain("m.id + '#' + m.commentId"); // stable per-mention identity
  });

  test("queue = unread (source minus read-set); panel hides at 0 unread", () => {
    expect(html).toContain("const read = loadMentionsRead()");
    expect(html).toContain("const unread = pend.filter((m) => !read[mentionReadKey(m)])");
    expect(html).toContain("if (!unread.length) { bar.hidden = true"); // 0 unread → hide, keep UI small
    expect(html).toContain("String(unread.length)"); // count reflects UNREAD, not the full queue
  });

  test("collapse-default: expand only on click", () => {
    expect(html).toContain("let mentionsExpanded = false"); // fresh load starts collapsed
    expect(html).toContain("if (mentionsExpanded) {"); // rows render only when expanded
    expect(html).toContain("mentions-caret");
  });

  test("read all + per-row mark-read write localStorage (current queue only)", () => {
    expect(html).toContain("mention-readall-btn");
    expect(html).toContain("read all");
    expect(html).toContain("for (const m of pend) map[mentionReadKey(m)] = true"); // read-all = current snapshot
    expect(html).toContain("mention-read-btn"); // per-row ✓
    expect(html).toContain("saveMentionsRead(map)");
  });

  test("queue reads the mention source without a resolve filter (kobo-237)", () => {
    // pendingMentions lists every @mention comment; the mentions panel no longer
    // filters by a `resolved` flag — the reader trims via the localStorage read-set.
    expect(html).toContain("function pendingMentions");
    expect(html).toContain("const unread = pend.filter((m) => !read[mentionReadKey(m)])");
  });
});
