import { describe, expect, test } from "bun:test";
import { orderCommentTree, foldableResolvedIds, newestVisibleCommentId, parseCardId, columnCollapsed, COLLAPSIBLE_COLS, companyHtml, lastActivityTs, hasUnread } from "./company";

// A comment factory — id, replyTo, ts, author. ts drives sibling order.
const c = (id: string, replyTo: string | null, ts: number, by = "sapan") => ({ id, replyTo, ts, by, text: id + " body" });
const ids = (nodes: { c: { id: string } }[]) => nodes.map((n) => n.c.id);
const indentOf = (nodes: { c: { id: string }; indent: number }[], id: string) => nodes.find((n) => n.c.id === id)!.indent;
const depthOf = (nodes: { c: { id: string }; depth: number }[], id: string) => nodes.find((n) => n.c.id === id)!.depth;

describe("orderCommentTree (kobo-171)", () => {
  test("linear depth-4 thread: all 4 present, DFS order, indent clamps at 2", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", "c2", 3), c("c4", "c3", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]); // NONE dropped (the bug)
    expect([depthOf(out, "c1"), depthOf(out, "c2"), depthOf(out, "c3"), depthOf(out, "c4")]).toEqual([0, 1, 2, 3]);
    expect([indentOf(out, "c1"), indentOf(out, "c2"), indentOf(out, "c3"), indentOf(out, "c4")]).toEqual([0, 1, 2, 2]); // clamp
  });

  test("sibling branch (c2↳c1, c3↳c1, c4↳c2): DFS keeps c2's subtree contiguous", () => {
    // c1 root; c2,c3 reply c1; c4 replies c2 → order c1, c2, c4, c3
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", "c1", 3), c("c4", "c2", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c4", "c3"]);
    expect(indentOf(out, "c4")).toBe(2);
  });

  test("siblings ordered by ts, not input order", () => {
    const out = orderCommentTree([c("c3", "c1", 30), c("c1", null, 10), c("c2", "c1", 20)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3"]);
  });

  test("dangling replyTo (parent missing) is surfaced as a root — never dropped", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c9", "cGONE", 2)]);
    expect(ids(out).sort()).toEqual(["c1", "c9"]);
    expect(depthOf(out, "c9")).toBe(0);
  });

  test("cycle in replyTo does not hang and drops nothing", () => {
    // a↔b reference each other — neither is a natural root; sweep must still surface both
    const out = orderCommentTree([c("a", "b", 1), c("b", "a", 2)]);
    expect(ids(out).sort()).toEqual(["a", "b"]);
  });

  test("multi-root threads render each root's subtree in a block", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", null, 3), c("c4", "c3", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("every comment appears exactly once (drop + dup guard)", () => {
    const input = [c("c1", null, 1), c("c2", "c1", 2), c("c3", "c2", 3), c("c4", "c1", 4), c("c5", "c3", 5)];
    const out = orderCommentTree(input);
    expect(out.length).toBe(input.length);
    expect(new Set(ids(out)).size).toBe(input.length);
  });
});

// r = a resolved comment; u = unresolved. ts drives sibling order.
const r = (id: string, replyTo: string | null, ts: number) => ({ id, replyTo, ts, by: "sapan", text: id, resolved: true });
const u = (id: string, replyTo: string | null, ts: number) => ({ id, replyTo, ts, by: "sapan", text: id, resolved: false });
const has = (set: Set<string>) => [...set].sort();

describe("foldableResolvedIds (kobo-176)", () => {
  test("a resolved leaf folds", () => {
    expect(has(foldableResolvedIds([u("c1", null, 1), r("c2", "c1", 2)]))).toEqual(["c2"]);
  });
  test("an unresolved comment never folds", () => {
    expect(foldableResolvedIds([u("c1", null, 1)]).size).toBe(0);
  });
  test("a resolved comment with an unresolved descendant stays visible (no orphan)", () => {
    // c1 resolved → c2 resolved → c3 UNRESOLVED. c1,c2 must NOT fold (ancestors of active reply)
    const set = foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), u("c3", "c2", 3)]);
    expect(set.size).toBe(0);
  });
  test("a fully-resolved branch folds entirely; a sibling active branch keeps its resolved ancestor shown", () => {
    // c1 resolved root; c2 resolved-leaf (folds); c3 resolved but has unresolved child c4 (c3 shown)
    const set = foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), r("c3", "c1", 3), u("c4", "c3", 4)]);
    // c1 has unresolved descendant c4 → shown; c3 shown; only c2 folds
    expect(has(set)).toEqual(["c2"]);
  });
  test("all-resolved thread folds every node", () => {
    expect(has(foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), r("c3", "c2", 3)]))).toEqual(["c1", "c2", "c3"]);
  });
});

describe("companyHtml injection (kobo-171 + kobo-176)", () => {
  test("the served client script contains the walker + fold fns and calls them (single source)", () => {
    const html = companyHtml();
    expect(html).toContain("function orderCommentTree"); // injected verbatim
    expect(html).toContain("orderCommentTree(comments)"); // and consumed by the renderer
    expect(html).toContain("function foldableResolvedIds"); // kobo-176 injected
    expect(html).toContain("foldableResolvedIds(comments)"); // and consumed
    expect(html).toContain("function newestVisibleCommentId"); // kobo-180 injected
    expect(html).toContain("scrollToNewestComment(task)"); // and called on open
    expect(html).toContain("function parseCardId"); // kobo-181 injected
    expect(html).toContain("addEventListener('popstate'"); // deep-link back/forward wired
    expect(html).toContain("syncUrlToCard(task.id)"); // and openDetail reflects the card in the URL
    expect(html).toContain("function columnCollapsed"); // kobo-194 injected
    expect(html).toContain("applyColumnCollapse()"); // and applied each render
    expect(html).toContain('class="col-chevron"'); // per-column toggle in backlog + rejected headers
    expect(html).toContain(".col.collapsed { display:none"); // kobo-197 — collapsed = removed from grid (was narrow strip)
  });
});

describe("board-collapse v2 — parking columns hidden + reveal button (kobo-197)", () => {
  const html = companyHtml();
  test("collapsed parking column is fully removed from the grid (display:none, not a strip)", () => {
    expect(html).toContain(".col.collapsed { display:none; }");
    expect(html).not.toContain(".col.collapsed > div { display:none"); // the old narrow-strip rule is gone
  });
  test("a reveal button exists and applyColumnCollapse drives it + reflows the grid", () => {
    expect(html).toContain('id="reveal-parking"');
    expect(html).toContain("getElementById('reveal-parking')");
    // active lanes reflow full-width: grid track count = visible columns
    expect(html).toContain("board.style.gridTemplateColumns = 'repeat('");
  });
  test("the reveal button bulk-toggles all parking columns (any hidden → reveal all)", () => {
    expect(html).toContain("COLLAPSIBLE_COLS.some((col) => columnCollapsed(col, state))");
    expect(html).toContain("state[col] = !anyHidden");
  });
  test("persistence reuses the kobo-194 localStorage key (no second store → coexist)", () => {
    expect(html).toContain("maw-company-collapsed");
  });
});

describe("columnCollapsed (kobo-194)", () => {
  test("backlog + rejected default to collapsed; active lanes never collapse", () => {
    expect(columnCollapsed("backlog", {})).toBe(true);
    expect(columnCollapsed("rejected", {})).toBe(true);
    for (const c of ["todo", "in-progress", "review", "approve", "done", "ready"]) {
      expect(columnCollapsed(c, {})).toBe(false); // active lane — always shown, incl. approve (kobo-189)
    }
  });
  test("persisted state overrides the default per collapsible column", () => {
    expect(columnCollapsed("backlog", { backlog: false })).toBe(false); // user expanded
    expect(columnCollapsed("backlog", { backlog: true })).toBe(true); // user re-collapsed
    expect(columnCollapsed("rejected", { rejected: false })).toBe(false);
  });
  test("a persisted flag on an ACTIVE lane is ignored (never collapsible)", () => {
    expect(columnCollapsed("todo", { todo: true })).toBe(false);
  });
  test("missing / non-object state → default", () => {
    expect(columnCollapsed("backlog", null)).toBe(true);
    expect(columnCollapsed("backlog", undefined)).toBe(true);
  });
  test("COLLAPSIBLE_COLS = backlog + rejected only", () => {
    expect(COLLAPSIBLE_COLS.slice().sort()).toEqual(["backlog", "rejected"]);
  });
});

describe("card-detail block reason (kobo-185 relations gap-fill)", () => {
  const html = companyHtml();
  test("renderDetailMeta shows the block REASON in full for a blocked card (guarded, XSS-safe)", () => {
    // only when task.block.reason exists (non-blocked cards carry no task.block)
    expect(html).toContain("task.block && task.block.reason");
    // rendered via el() (textContent) into a full-width wrapping line, not a clamped pill
    expect(html).toContain("'detail-block-reason', '⚑ ' + task.block.reason");
    expect(html).toContain(".detail-block-reason {");
    expect(html).toContain("flex-basis:100%"); // its own line, wraps in full
  });
});

describe("board lane visibility — Blocked in grid + hide-empty (kobo-199)", () => {
  const html = companyHtml();
  test("Blocked is a normal grid column (col-blocked) before Done; floating attention lane is gone", () => {
    expect(html).toContain('class="col col-blocked"');
    expect(html).toContain('id="blocked"');
    expect(html).not.toContain('id="attention-panel"'); // kobo-55 floating lane removed
    expect(html).not.toContain('class="attention"');
    expect(html.indexOf('col-approve')).toBeLessThan(html.indexOf('col-blocked'));
    expect(html.indexOf('id="blocked"')).toBeLessThan(html.indexOf('id="done"'));
  });
  test("COLS carries blocked; hide-empty set covers the non-parking lanes but EXEMPTS blocked (always-on)", () => {
    expect(html).toContain("'approve', 'blocked', 'done'"); // COLS ordering
    // blocked is deliberately NOT in HIDE_WHEN_EMPTY → always-on (Tony's complaint).
    expect(html).toContain("const HIDE_WHEN_EMPTY = ['todo', 'ready', 'in-progress', 'review', 'approve', 'done']");
    expect(html).not.toContain("'approve', 'blocked', 'done']"); // never re-added to the hide set
  });
  test("a hide-empty lane vanishes at 0 cards; parking stays reveal-controlled", () => {
    expect(html).toContain(".col.lane-empty { display:none");
    expect(html).toContain("colEl.classList.toggle('lane-empty', counts[s] === 0)");
    expect(html).toContain("cols[s].appendChild(el('div', 'empty', '—'))"); // parking / always-on keep the marker
  });
  test("grid reflow excludes both collapsed (parking) and lane-empty columns", () => {
    expect(html).toContain("!c.classList.contains('collapsed') && !c.classList.contains('lane-empty')");
  });
});

describe("parseCardId (kobo-181)", () => {
  test("extracts the card param", () => {
    expect(parseCardId("?card=kobo-5&company=kobo")).toBe("kobo-5");
    expect(parseCardId("?company=kobo&card=pgw-12")).toBe("pgw-12");
  });
  test("missing / empty card param → empty string", () => {
    expect(parseCardId("?company=kobo")).toBe("");
    expect(parseCardId("?card=")).toBe("");
    expect(parseCardId("")).toBe("");
  });
});

describe("approve column (kobo-189)", () => {
  test("served board has an Approve column + count slot between Review and Done", () => {
    const html = companyHtml();
    expect(html).toContain('id="approve"'); // the lane container
    expect(html).toContain('id="c-approve"'); // its count slot
    expect(html).toContain('>Approve<'); // header label
    // ordering: Review column appears before Approve, Approve before Done
    expect(html.indexOf('id="review"')).toBeLessThan(html.indexOf('id="approve"'));
    expect(html.indexOf('id="approve"')).toBeLessThan(html.indexOf('id="done"'));
  });
  test("FLOW/COLS in the client script include approve", () => {
    const html = companyHtml();
    expect(html).toContain("'review', 'approve', 'done'"); // FLOW/COLS ordering
  });
});

describe("newestVisibleCommentId (kobo-180)", () => {
  const r = (id: string, ts: number) => ({ id, replyTo: null, ts, by: "sapan", text: id, resolved: true });
  const u = (id: string, ts: number) => ({ id, replyTo: null, ts, by: "sapan", text: id, resolved: false });
  test("picks the newest comment by ts", () => {
    expect(newestVisibleCommentId([u("c1", 1), u("c2", 3), u("c3", 2)], new Set())).toBe("c2");
  });
  test("newest is folded → falls back to the newest VISIBLE one", () => {
    // c3 is newest but resolved-leaf (folded) → target c2 (newest unresolved)
    const comments = [u("c1", 1), u("c2", 2), r("c3", 3)];
    const folded = foldableResolvedIds(comments); // {c3}
    expect(newestVisibleCommentId(comments, folded)).toBe("c2");
  });
  test("all comments folded → null (nothing visible to scroll to)", () => {
    const comments = [r("c1", 1), r("c2", 2)];
    expect(newestVisibleCommentId(comments, foldableResolvedIds(comments))).toBeNull();
  });
  test("tie on ts → later in creation order wins", () => {
    expect(newestVisibleCommentId([u("c1", 5), u("c2", 5)], new Set())).toBe("c2");
  });
  test("empty → null", () => {
    expect(newestVisibleCommentId([], new Set())).toBeNull();
  });
});

describe("lastActivityTs / hasUnread (kobo-208)", () => {
  test("lastActivityTs = max of updatedTs + note ts + comment ts", () => {
    expect(lastActivityTs({ id: "k1", updatedTs: 10, notes: [{ ts: 30 }], comments: [{ ts: 20 }] })).toBe(30);
    expect(lastActivityTs({ id: "k1", updatedTs: 50, notes: [{ ts: 30 }] })).toBe(50); // own update newest
    expect(lastActivityTs({ id: "k1", comments: [{ ts: 7 }, { ts: 99 }] })).toBe(99);
  });
  test("lastActivityTs on a bare card → 0", () => {
    expect(lastActivityTs({ id: "k1" })).toBe(0);
    expect(lastActivityTs(null)).toBe(0);
  });
  test("never-opened card with activity → unread", () => {
    expect(hasUnread({ id: "k1", updatedTs: 5 }, {})).toBe(true); // no seen entry → 0
  });
  test("seen after latest activity → read; new activity after seen → unread", () => {
    const task = { id: "k1", updatedTs: 10, comments: [{ ts: 40 }] };
    expect(hasUnread(task, { k1: 40 })).toBe(false); // seen at/after newest activity
    expect(hasUnread(task, { k1: 50 })).toBe(false); // seen strictly newer
    expect(hasUnread(task, { k1: 30 })).toBe(true);  // activity (40) after last open (30)
  });
  test("no activity + never opened → not unread (0 > 0 is false)", () => {
    expect(hasUnread({ id: "k1" }, {})).toBe(false);
  });
});
