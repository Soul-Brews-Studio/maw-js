import { describe, expect, test } from "bun:test";
import { orderCommentTree, newestVisibleCommentId, parseCardId, columnCollapsed, COLLAPSIBLE_COLS, companyHtml, lastActivityTs, hasUnread } from "./company";

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

// kobo-443: ctxPct() lives inside the served client script (companyHtml's
// template literal), same as room.ts's client-side helpers — extract it
// straight from the served HTML the same way room.test.ts does for
// loadMermaidRenderer, rather than reimplementing it here (a reimplementation
// could silently drift from what actually ships).
function loadCtxPct() {
  const html = companyHtml();
  const start = html.indexOf("function ctxPct(p)");
  const end = html.indexOf("function renderPresence");
  const src = html.slice(start, end);
  return new Function(`${src}; return ctxPct;`)();
}

describe("ctxPct — board context% readout (kobo-443)", () => {
  test("normal row: a plain remaining_percentage passes through rounded", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ remaining_percentage: 29.6 })).toBe(30);
  });

  test("both null (no API call yet / just compacted): returns null, not 0", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ remaining_percentage: null, used_percentage: null })).toBeNull();
    expect(ctxPct({})).toBeNull();
  });

  // 🔴 the AC's named branch: total_input_tokens is the CUMULATIVE session
  // counter, not current usage — once it exceeds the pane's own window,
  // upstream's remaining_percentage/used_percentage are a lying flat 0/100.
  test("tok > win (cumulative counter exceeded the window): returns null, NEVER 0 and NEVER 100", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 944264, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBeNull();
  });

  // regression guard: the tok>win guard must NOT swallow a genuinely-near-full
  // pane (tok <= win, remaining_percentage really is 0) — that's real signal.
  test("a real near-full pane (tok <= win, remaining_percentage genuinely 0) still shows 0, not masked to null", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 199999, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBe(0);
  });

  // kobo-443 review (eq3 L1): at exactly tok == win the pane is legitimately
  // full — the number is not corrupt (corruption only starts once the
  // cumulative counter goes PAST the window) — so this must render 0, the
  // same as any other real near-full pane, not the em-dash. Pins the `>`
  // boundary: mutating it to `>=` stayed green with no test watching this.
  test("boundary: tok == win exactly is a legitimately full pane, renders 0 (not the em-dash)", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 200000, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBe(0);
  });

  // the board shows REMAINING, not used — lock the DIRECTION explicitly (the
  // same family of bug as the statusline's inverted label, kobo-441): a
  // mostly-EMPTY pane (used_percentage low) must show a HIGH number here.
  test("direction: a mostly-empty pane (used_percentage low) reads as a HIGH percentage here (remaining, not used)", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ used_percentage: 5 })).toBe(95);
  });
});

// kobo-443: the ctx-span label direction fix — extract just the 3 lines that
// build the span (narrower than the whole renderPresence, which also drives
// roster grouping/pane-state unrelated to this bug) with a minimal `el` stub.
function loadCtxLabel(p: Record<string, any>) {
  const html = companyHtml();
  const start = html.indexOf("const pct = ctxPct(p);");
  const end = html.indexOf("row.appendChild(ctx);");
  const src = html.slice(start, end);
  const el = (_tag: string, cls: string, txt: string) => ({ className: cls, textContent: txt, title: "" });
  const ctxPct = loadCtxPct();
  return new Function("el", "ctxPct", "p", `${src}; return ctx;`)(el, ctxPct, p);
}

describe("ctx-span label direction (kobo-443 — same bug family as the statusline inversion)", () => {
  test("a normal pct states its OWN direction in the visible text, not just in a hover-only title", () => {
    const ctx = loadCtxLabel({ remaining_percentage: 42 });
    expect(ctx.textContent).toBe("ctx 42% left");
    expect(ctx.title).toBe("42% context remaining");
  });

  test("null still renders the unchanged em-dash — no regression", () => {
    const ctx = loadCtxLabel({});
    expect(ctx.textContent).toBe("ctx —");
    expect(ctx.title).toBe("");
  });

  test("stale pane: no title is set even when pct is known (existing behavior, unchanged)", () => {
    const ctx = loadCtxLabel({ remaining_percentage: 42, stale: true });
    expect(ctx.textContent).toBe("ctx 42% left");
    expect(ctx.title).toBe("");
  });
});

// kobo-237: the resolve concept is removed — comment-fold tests deleted.
describe("companyHtml injection (kobo-171; kobo-237 removed resolve-fold)", () => {
  test("the served client script contains the walker fns and calls them (single source)", () => {
    const html = companyHtml();
    expect(html).toContain("function orderCommentTree"); // injected verbatim
    expect(html).toContain("orderCommentTree(comments)"); // and consumed by the renderer
    expect(html).not.toContain("function foldableResolvedIds"); // kobo-237: fold removed
    expect(html).not.toContain("/api/tasks/resolve"); // kobo-237: resolve route gone
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

// kobo-425: the board's `>` blockquote CSS (`.md blockquote`) existed since
// before md.ts's blockquote regex actually worked (kobo-396's escape-first
// broke it — see md.test.ts), so it rendered NOTHING. Fixing the shared
// regex makes `.md blockquote` live for the first time — this pins that the
// board still gets the ORIGINAL thin-gray-line design (room's red BOX is a
// separately-scoped `.bubble .body blockquote` rule, added in room.ts only).
describe("kobo-425: board `.md` blockquote/strong stay the pre-existing thin-line design (room's red-box highlight is scoped elsewhere, never here)", () => {
  const html = companyHtml();
  test("`.md blockquote` is still the original thin gray left-line, not a red box", () => {
    expect(html).toContain(".md blockquote { border-left:3px solid var(--line); margin:8px 0; padding:2px 0 2px 12px; color:var(--muted); }");
    expect(html).not.toContain("var(--danger)"); // the board never grows a red box
  });
  test("`.md strong` is still plain bold, no highlighter background", () => {
    expect(html).toContain(".md strong { color:var(--fg); }");
  });

  // kobo-456: mdToHtml (shared) now tags every <p> with a pg-N class for
  // room's paragraph colouring. The board gets the SAME class (one renderer,
  // kobo-396) but must render it with ZERO visual effect — a class with no
  // matching CSS rule does nothing, same pattern as strong/blockquote above.
  test("kobo-456: the board has NO .md p.pg-N colour rule — the class exists in shared HTML but is inert here", () => {
    for (let n = 0; n < 4; n++) {
      expect(html).not.toContain(`.md p.pg-${n}`);
    }
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
  test("COLLAPSIBLE_COLS = backlog + rejected + wait-for-deploy (kobo-273)", () => {
    expect(COLLAPSIBLE_COLS.slice().sort()).toEqual(["backlog", "rejected", "wait-for-deploy"]);
  });
});

describe("wait-for-deploy lane (kobo-273 — merged≠live park)", () => {
  const html = companyHtml();
  test("wait-for-deploy is collapsible but DEFAULT-OPEN (deploy reminder must show)", () => {
    // collapsible like backlog (has a chevron)…
    expect(COLLAPSIBLE_COLS).toContain("wait-for-deploy");
    // …yet columnCollapsed defaults it OPEN, unlike default-collapsed backlog/rejected.
    expect(columnCollapsed("wait-for-deploy", {})).toBe(false);
    expect(columnCollapsed("backlog", {})).toBe(true);
    // explicit user choice still wins (can fold it).
    expect(columnCollapsed("wait-for-deploy", { "wait-for-deploy": true })).toBe(true);
  });
  test("renders as its own column with a chevron, between approve and blocked", () => {
    expect(html).toContain('class="col col-wait-for-deploy"');
    expect(html).toContain('id="wait-for-deploy"');
    expect(html).toContain('data-col="wait-for-deploy"'); // chevron
    expect(html.indexOf('col-approve')).toBeLessThan(html.indexOf('col-wait-for-deploy'));
    expect(html.indexOf('col-wait-for-deploy')).toBeLessThan(html.indexOf('col-blocked'));
  });
});

describe("presence cell clamp (kobo-284)", () => {
  const html = companyHtml();
  test(".p-last + .p-status clamp to 1 line with ellipsis (no multi-line spill)", () => {
    expect(html).toContain(".presence-cell .p-last { color:var(--fg); font-size:var(--t-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }");
    expect(html).toContain(".presence-cell .p-status { color:var(--st-meta); font-size:var(--t-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }");
    // the old multi-line spill is gone
    expect(html).not.toContain(".p-last { color:var(--fg); font-size:var(--t-sm); white-space:pre-wrap; word-break:break-word; }");
  });
  test("full text is preserved on hover via the title attribute", () => {
    expect(html).toContain("lastEl.title = lastTxt"); // p-last tooltip
    expect(html).toContain("statusEl.title = statusTxt"); // p-status tooltip
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
    expect(html).toContain("'approve', 'wait-for-deploy', 'blocked', 'done'"); // COLS ordering (kobo-273 lane inserted before blocked)
    // blocked is deliberately NOT in HIDE_WHEN_EMPTY → always-on (Tony's complaint).
    expect(html).toContain("const HIDE_WHEN_EMPTY = ['todo', 'ready', 'in-progress', 'review', 'need-answer', 'approve', 'done']");
    expect(html).not.toContain("'approve', 'blocked', 'done']"); // never re-added to the hide set
  });
  test("need-answer (kobo-218) is its own Tony-queue column between review and approve, hide-when-empty", () => {
    expect(html).toContain('class="col col-need-answer"');
    expect(html).toContain('id="need-answer"');
    expect(html.indexOf('col-review')).toBeLessThan(html.indexOf('col-need-answer'));
    expect(html.indexOf('col-need-answer')).toBeLessThan(html.indexOf('col-approve'));
    // COLS + HIDE_WHEN_EMPTY carry it (own lane, vanishes at 0 like approve — NOT in Blocked)
    expect(html).toContain("'review', 'need-answer', 'approve', 'wait-for-deploy', 'blocked', 'done'");
    expect(html).toContain("'review', 'need-answer', 'approve', 'done']"); // HIDE_WHEN_EMPTY (wait-for-deploy NOT hide-empty — it's reveal-controlled parking)
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

describe("newestVisibleCommentId (kobo-180; kobo-237: single-arg, no fold)", () => {
  const cm = (id: string, ts: number) => ({ id, replyTo: null, ts, by: "sapan", text: id });
  test("picks the newest comment by ts", () => {
    expect(newestVisibleCommentId([cm("c1", 1), cm("c2", 3), cm("c3", 2)])).toBe("c2");
  });
  test("every comment is a candidate (no fold) → newest wins", () => {
    expect(newestVisibleCommentId([cm("c1", 1), cm("c2", 2), cm("c3", 3)])).toBe("c3");
  });
  test("tie on ts → later in creation order wins", () => {
    expect(newestVisibleCommentId([cm("c1", 5), cm("c2", 5)])).toBe("c2");
  });
  test("empty → null", () => {
    expect(newestVisibleCommentId([])).toBeNull();
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
  test("kobo-401: lastActivityTs honors server-precomputed maxActivityTs (bulk-list cards no longer carry notes/comments arrays)", () => {
    expect(lastActivityTs({ id: "k1", updatedTs: 10, maxActivityTs: 30 })).toBe(30);
    expect(lastActivityTs({ id: "k1", updatedTs: 50, maxActivityTs: 30 })).toBe(50); // own update still newest
    expect(lastActivityTs({ id: "k1", maxActivityTs: 30, comments: [{ ts: 99 }] })).toBe(99); // a full-detail task (post card-open) still scans arrays too
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

describe("card-detail action buttons (kobo-225)", () => {
  const html = companyHtml();
  test("wires each button to its rule-guarded endpoint", () => {
    expect(html).toContain("/api/tasks/reject"); // reject → Rejected lane
    expect(html).toContain("/api/tasks/assign"); // reassign (friction)
    expect(html).toContain("/api/tasks/edit");   // edit reviewer
    expect(html).toContain("reject-btn");
  });
  test("mark-done is DISABLED on a PR-linked card (closes on merge, kobo-228)", () => {
    // the disable branch keys off task.pr + explains the PR auto-close
    expect(html).toContain("typeof task.pr === 'number'");
    expect(html).toContain("auto-closes on merge");
  });
  test("reassign asks a force-confirm on the 409 needsForce (kobo-219 friction)", () => {
    expect(html).toContain("needsForce");
    expect(html).toContain("confirm-reassign");
  });
});
