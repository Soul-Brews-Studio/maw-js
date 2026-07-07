import { Hono } from "hono";
import { createHash } from "crypto";

// kobo-57 cache-bust — the served board is a static HTML/CSS/JS blob. A deploy
// changes it, but a viewer with an open tab keeps the OLD copy (the 5s poll only
// refreshes DATA, not the page shell) until they hard-reload by hand. Fix: stamp
// the page with a content hash + expose it at GET /api/version; the client polls
// it and shows a "reload" banner when the served version differs from the one it
// loaded with. Content hash (not git sha / boot time) → changes IFF the HTML
// actually changed, so an identical redeploy raises no false banner.
const VERSION_TOKEN = "__APP_VERSION__";
let _companyVersion: string | null = null;

/** Memoized content hash of the served board — the cache-bust version (kobo-57). */
export function companyVersion(): string {
  if (!_companyVersion) {
    _companyVersion = createHash("sha1").update(companyBody()).digest("hex").slice(0, 12);
  }
  return _companyVersion;
}

/**
 * company-ui (read-only) — board + worklog timeline for one company.
 *
 * ADD route alongside the federation UI (ui/office) — does NOT replace it.
 * Panels, all read-only projections (spec §6 + addendum). The renderer is
 * generic — each panel declares a `type` so new ones drop in later:
 *   - kanban        backlog→todo→ready→in-progress→review→done + blocked (off-flow)
 *                   (off-flow) · wait-for badge derived · from GET /api/tasks
 *   - worklog-feed  activity timeline        from GET /api/worklog/feed?company=<c>
 *   - markdown-file coordination state doc   from GET /api/state?company=<c>
 *                   (hidden when the company has no state.md — never an error)
 *
 * Generic via ?company= → same renderer serves kobo, pgw, … Interactive
 * drag/write is a later phase (see spec §6/§9). For now: poll + refresh.
 */

// kobo-184 — state badge for the card-detail modal header. Pure map so the
// label/color logic is unit-tested; wired into the client script via
// `${stateBadge.toString()}` (single source, no drift). The color comes from
// the SAME lane token as the board column + card left-border (.task.st-*), so a
// card's state reads identically in the modal and on the board. Blocked appends
// its for-who (task.block.for) when present. Returns { cls, label }.
export function stateBadge(task) {
  const state = (task && task.state) || 'todo';
  const LABEL = {
    backlog: 'Backlog', todo: 'Todo', ready: 'Ready', 'in-progress': 'In Progress',
    review: 'Review', blocked: 'Blocked', done: 'Done', rejected: 'Rejected',
  };
  let label = LABEL[state] || state;
  if (state === 'blocked' && task && task.block && task.block.for) label += ' →' + task.block.for;
  return { cls: 'pill state st-' + state, label };
}

/** Render the board HTML, stamping the live version into the placeholders. */
export function companyHtml(): string {
  return companyBody().replaceAll(VERSION_TOKEN, companyVersion());
}

// kobo-171: pure comment-tree walker — the single source of truth for how a
// comment thread is ordered + indented. Kept DOM-free and annotation-free so it
// (1) unit-tests without a browser and (2) is injected verbatim into the served
// client script via `${orderCommentTree.toString()}` — no duplicated logic to
// drift. Recurses the FULL tree (fixes the depth-3+ drop bug); DFS pre-order so a
// root's whole subtree renders contiguously; siblings ordered by ts (id as
// tiebreak). Indent is CLAMPED to 2 levels (min(depth,2)) — data/replyTo is never
// touched, only the visual indent. Never drops: a comment whose replyTo is
// missing is surfaced as a root, and a final sweep re-homes anything a cycle
// would otherwise strand. Returns [{ c, depth, indent }] in render order.
export function orderCommentTree(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  const kids = new Map();
  const roots = [];
  for (const c of comments) {
    const p = c.replyTo;
    if (p && byId.has(p)) {
      const a = kids.get(p) || []; a.push(c); kids.set(p, a);
    } else {
      roots.push(c); // real root, or dangling replyTo → treat as root (never drop)
    }
  }
  const byTs = (a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id));
  roots.sort(byTs);
  const out = [];
  const seen = new Set();
  const walk = (c, depth) => {
    if (seen.has(c.id)) return; // cycle guard — never recurse a node twice
    seen.add(c.id);
    out.push({ c: c, depth: depth, indent: depth < 2 ? depth : 2 });
    const ch = kids.get(c.id);
    if (ch) { ch.sort(byTs); for (const k of ch) walk(k, depth + 1); }
  };
  for (const r of roots) walk(r, 0);
  for (const c of comments) if (!seen.has(c.id)) walk(c, 0); // sweep any cycle-stranded node
  return out;
}

// kobo-176: which resolved comments are foldable (safe to hide when "show
// resolved" is off). A resolved comment folds ONLY when its ENTIRE subtree is
// resolved — a resolved comment that is the ancestor of an unresolved reply must
// stay visible, or its child's indent/reply-target chip (kobo-171) would orphan.
// DOM-free + annotation-free: unit-tested, then injected verbatim into the client
// script via `${foldableResolvedIds.toString()}` (single source, no drift).
// Returns a Set of comment ids that are foldable.
export function foldableResolvedIds(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  const kids = new Map();
  for (const c of comments) {
    if (c.replyTo && byId.has(c.replyTo)) {
      const a = kids.get(c.replyTo) || []; a.push(c); kids.set(c.replyTo, a);
    }
  }
  const memo = new Map();
  const stack = new Set(); // cycle guard
  const subtreeAllResolved = (c) => {
    if (memo.has(c.id)) return memo.get(c.id);
    if (stack.has(c.id)) return false; // cycle → conservative: not all-resolved, so never hide
    stack.add(c.id);
    let all = !!c.resolved;
    for (const k of (kids.get(c.id) || [])) { if (!subtreeAllResolved(k)) all = false; }
    stack.delete(c.id);
    memo.set(c.id, all);
    return all;
  };
  const foldable = new Set();
  for (const c of comments) if (c.resolved && subtreeAllResolved(c)) foldable.add(c.id);
  return foldable;
}

// kobo-180: the id of the newest comment that is actually VISIBLE — the auto-scroll
// target on card open. Skips folded (fully-resolved) comments (foldableIds from
// foldableResolvedIds, kobo-176) so we never scroll to a display:none element.
// Newest = max ts; ties break to the later one in creation order (comments are
// append-only). Returns null when nothing is visible (every comment folded) → the
// caller then does nothing. DOM-free + annotation-free: unit-tested, injected into
// the client script via `${newestVisibleCommentId.toString()}` (single source).
export function newestVisibleCommentId(comments, foldableIds) {
  let best = null;
  for (const c of comments) {
    if (foldableIds && foldableIds.has && foldableIds.has(c.id)) continue; // folded → not a scroll target
    if (best === null || (c.ts || 0) >= (best.ts || 0)) best = c; // >= → later-in-array wins a tie
  }
  return best ? best.id : null;
}

// kobo-181: the card id from a URL query string (?card=<id>) — the deep-link
// target. Pure (takes location.search, not window) so it unit-tests; injected into
// the client script via `${parseCardId.toString()}`. Empty string = no card param.
export function parseCardId(search) {
  return (new URLSearchParams(search || "").get("card") || "").trim();
}

// kobo-194: which board columns can collapse (parking + terminal lanes) — active
// flow lanes (todo…done, incl. approve) are NEVER collapsed. Kept as a literal set
// so a rebase that adds a lane (e.g. approve, kobo-189) leaves it untouched.
export const COLLAPSIBLE_COLS = ["backlog", "rejected"];

// kobo-194: is `col` collapsed right now? Only collapsible columns can be; among
// them the default is COLLAPSED, overridden per-column by the persisted state
// (localStorage map {col:boolean}). DOM-free + annotation-free: unit-tested, then
// injected into the client script via `${columnCollapsed.toString()}`.
export function columnCollapsed(col, state) {
  if (!COLLAPSIBLE_COLS.includes(col)) return false; // active lane — always shown
  const s = state && typeof state === "object" ? state : {};
  return col in s ? !!s[col] : true; // explicit user choice wins, else default-collapsed
}

function companyBody(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="app-version" content="${VERSION_TOKEN}" />
  <title>maw company</title>
  <style>
    /* kobo-71 palette retune (maw-pane anchor, Tony color direction): --accent =
       coral/pink (PANE pink), and interactive LINKS split out to --link (amber) so
       accent is brand/state only. Light-theme variants are darkened to keep AA
       contrast on the light bg. Names locked — values only; every view inherits. */
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --col:#0e141d; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --bad:#ff8e8e; --warn:#ffd37a; --accent:#ff5f87; --link:#ffd700; }
    body.light { color-scheme: light; --bg:#f6f8fb; --card:#ffffff; --col:#eef2f7; --muted:#5b6b77; --fg:#1b2430; --line:#d8e0ea; --ok:#1f9d57; --bad:#c8443a; --warn:#9a6b12; --accent:#d6336c; --link:#a67c00; }
    /* ── kobo-59 UI Foundation — design tokens (epic kobo-58 root; subtasks 2-6 build on these).
       Hybrid identity: modern structure + terminal accent. The color vars above stay the
       theme-switched base (--bg/--card/--accent…); below are the SEMANTIC colors + SCALE tokens
       every primitive shares. Values MATCH the current look — this PR changes no appearance/behavior;
       subtasks migrate views onto the tokens incrementally. Primitives (shared classes) that consume
       these: .card (Card) · .pill (Badge) · .tab (Tab) · button/.archive-btn/.done-btn (Button) ·
       .overlay+.modal (Modal shell) · .task (board card) · #detail-notes .note (note bubble). */
    :root {
      /* semantic accent colors — recurring inline hex, de-duplicated to one source */
      --epic:#c4a7ff;                 /* epic / subtask purple */
      --field-bg:#0d131c;             /* input / textarea / code / button surface */
      --bd-ok:#2f5a3f; --bd-bad:#6b3a3a; --bd-epic:#4a3a6b; --bd-warn:#5a4a22; --bd-accent:#31516b; /* badge/button border tints */
      /* semantic STATUS colors — modal-body structured blocks (kobo-58 #4, worker-3 design).
         Aliases onto the base palette so the whole epic shares one color contract; the base
         tokens (--card/--accent/--ok/--bad/--warn/--line/--muted) stay unchanged. */
      --st-source:var(--accent);   /* source / target / host — provenance */
      --st-premise:var(--warn);    /* premise / interim — provisional / caution */
      --st-bug:var(--bad);         /* bug / broken */
      --st-accept:var(--ok);       /* accept / decision — settled / go */
      --st-meta:var(--muted);      /* meta / secondary detail */
      /* radius scale */
      --r-xs:6px; --r-sm:8px; --r-md:10px; --r-lg:12px; --r-xl:14px; --r-pill:999px;
      /* spacing scale (the px steps actually in use, ranked xs→xl) */
      --s-1:4px; --s-2:6px; --s-3:8px; --s-4:10px; --s-5:12px; --s-6:14px; --s-7:16px; --s-8:18px; --s-9:24px;
      /* type scale */
      --t-xs:11px; --t-sm:12px; --t-base:13px; --t-md:14px; --t-lg:15px; --t-xl:18px; --t-2xl:22px;
      /* fonts — mono is the terminal accent (ids/code) and the board's default UI face */
      --font-mono: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      /* kobo-60 — a readable sans for long prose (card-detail body). Spec §1 locked
         "mono เฉพาะ code/id": the modal body is the one long-prose surface, so it
         reads sans while ids/code/labels stay mono. Scoped to #detail-body only —
         the rest of the board keeps its terminal (mono) face. */
      --font-ui: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin:0; padding:var(--s-9); font:var(--t-md)/1.45 var(--font-mono); background:var(--bg); color:var(--fg); transition:background .2s ease, color .2s ease; }
    /* kobo-61 — global header bar (brand · switcher · theme-toggle). Token-driven
       so both themes inherit; presentation only — company-switch/theme logic and
       every id are untouched. The tab row below keeps its own underline rail, so
       the header stays borderless to avoid a double divider. */
    header { display:flex; align-items:center; justify-content:space-between; gap:var(--s-7); margin:0 0 var(--s-5); flex-wrap:wrap; }
    .brand { display:flex; flex-direction:column; gap:var(--s-1); }
    h1 { margin:0; font-size:var(--t-2xl); letter-spacing:.02em; display:flex; align-items:center; gap:var(--s-3); }
    h1 .logo { color:var(--accent); font-size:var(--t-xl); }
    h1 .co { color:var(--accent); }
    .sub { color:var(--muted); font-size:var(--t-sm); }
    .controls { display:flex; gap:var(--s-4); align-items:center; }
    .controls .switcher { color:var(--muted); font-size:var(--t-xs); }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:5px; }
    input, button { background:var(--field-bg); color:var(--fg); border:1px solid var(--line); border-radius:var(--r-sm); padding:var(--s-3) var(--s-4); font:inherit; }
    .controls input:focus { outline:none; border-color:var(--accent); }
    button { cursor:pointer; border-color:var(--bd-accent); color:var(--accent); }
    .layout { display:grid; grid-template-columns: 1fr 360px; gap:16px; align-items:start; }
    /* Card primitive — surface for panels/columns/modals. */
    .card { background:var(--card); border:1px solid var(--line); border-radius:var(--r-xl); padding:var(--s-6); box-shadow:0 12px 28px rgba(0,0,0,.25); }
    /* grid-template-columns is a static fallback; applyColumnCollapse (kobo-197)
       overrides it inline with the VISIBLE column count so active lanes reflow to
       full width when the parking columns are hidden. */
    .board { display:grid; grid-template-columns: repeat(9, minmax(150px, 1fr)); gap:10px; overflow-x:auto; }
    .col { background:var(--col); border:1px solid var(--line); border-radius:12px; padding:10px; min-height:120px; min-width:0; } /* kobo-198 — grid item shrinks to its track (min-width:auto would let card content force the column wider → board blowout) */
    /* kobo-197 — reveal/hide control for the parking columns (backlog + rejected). */
    .board-toolbar { display:flex; justify-content:flex-end; margin-bottom:8px; }
    .reveal-parking { background:var(--field-bg); border:1px solid var(--line); border-radius:8px; color:var(--muted); cursor:pointer; font:inherit; font-size:11px; padding:3px 10px; }
    .reveal-parking:hover, .reveal-parking:focus-visible { color:var(--fg); border-color:var(--muted); }
    .col h2 { margin:0 0 10px; font-size:12px; font-weight:600; color:var(--muted); display:flex; align-items:center; justify-content:space-between; gap:6px; }
    .col h2 .count { color:var(--fg); margin-left:auto; } /* kobo-194 — count stays right so a leading chevron groups with the label */
    /* kobo-194 chevron (per-column re-hide, shown once a parking column is revealed).
       kobo-197 — collapsed = the parking column is REMOVED from the grid entirely
       (display:none, not a narrow strip), so active lanes reflow to full width. */
    .col-chevron { background:none; border:0; color:inherit; cursor:pointer; font:inherit; font-size:11px; line-height:1; padding:0; }
    .col-chevron:hover, .col-chevron:focus-visible { color:var(--fg); }
    .col.collapsed { display:none; }
    /* kobo-199 — a NON-parking lane with 0 cards is hidden from the grid (renderBoard
       toggles this by count); backlog/rejected are PARKING and keep the 194/197 reveal
       control instead of empty-hiding. applyColumnCollapse counts neither as visible. */
    .col.lane-empty { display:none; }
    .col-backlog h2 { color:var(--muted); } .col-todo h2 { color:var(--warn); }
    .col-ready h2 { color:var(--ok); } /* kobo-133 — deps cleared, green light to start */
    .col-in-progress h2 { color:var(--accent); } .col-review h2 { color:var(--epic); } .col-approve h2 { color:var(--link); } .col-done h2 { color:var(--ok); }
    .col-blocked h2 { color:var(--bad); } /* kobo-199 — Blocked is now a normal grid column (was the floating attention lane, kobo-55) */
    .col-rejected h2 { color:var(--warn); } /* kobo-101 — terminal "not accepted", parallel to Done */
    .task { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:var(--r-md); padding:var(--s-3) var(--s-4); margin-bottom:var(--s-3); }
    /* kobo-62 — state-accent left border: the card tells its own state at a glance
       (redundant with the column, so state is never conveyed by color alone). */
    .task.st-backlog { border-left-color:var(--muted); }
    .task.st-todo { border-left-color:var(--warn); }
    .task.st-ready { border-left-color:var(--ok); } /* kobo-133 */
    .task.st-in-progress { border-left-color:var(--accent); }
    .task.st-review { border-left-color:var(--epic); }
    .task.st-approve { border-left-color:var(--link); } /* kobo-189 — human gate (gold) */
    .task.st-done { border-left-color:var(--ok); }
    .task.st-blocked { border-left-color:var(--bad); }
    /* kobo-62 — progressive card face: title + assignee avatar on one row. */
    .task .t-head { display:flex; align-items:flex-start; gap:var(--s-3); }
    .task .t-title { color:var(--fg); flex:1 1 auto; min-width:0; }
    /* kobo-127 — collapse: title clamps to ONE line (ellipsis); full text in title=+modal. */
    .task .t-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .task .t-avatar { flex:0 0 auto; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:var(--t-xs); font-weight:700; letter-spacing:.02em; }
    .task .t-avatar.unassigned { background:var(--field-bg); border:1px dashed var(--line); color:var(--muted); }
    /* kobo-127 — assignee CHIP (full name + per-person color, click = filter). */
    .task .assignee-chip { flex:0 0 auto; max-width:44%; overflow:hidden; text-overflow:ellipsis; font-weight:600; font-size:var(--t-xs); border:1px solid transparent; }
    .task .assignee-chip.unassigned { background:var(--field-bg); border:1px dashed var(--line); color:var(--muted); font-weight:400; }
    /* kobo-127 — note surfacing on the face: collapsed = latest 1 faint line;
       Blocked lane = every note in full (Tony's decision queue). */
    .task .t-note-latest { margin-top:var(--s-2); color:var(--muted); font-size:var(--t-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75; }
    .task .t-notes-full { margin-top:var(--s-2); display:flex; flex-direction:column; gap:var(--s-1); }
    .task .t-notes-full .t-note { color:var(--fg); font-size:var(--t-sm); white-space:pre-wrap; word-break:break-word; border-left:2px solid var(--line); padding-left:var(--s-3); }
    .task .t-note-by { color:var(--muted); font-weight:600; }
    /* kobo-127 — Done-lane fold control ("show all N" / "collapse"). */
    .done-fold { grid-column:1 / -1; margin-top:var(--s-2); font-size:var(--t-xs); color:var(--muted); background:none; border:1px dashed var(--line); border-radius:var(--r-md); padding:var(--s-2) var(--s-4); cursor:pointer; width:100%; }
    .done-fold:hover { color:var(--fg); border-color:var(--accent); }
    .task .t-meta { color:var(--muted); font-size:var(--t-sm); margin-top:var(--s-2); display:flex; gap:var(--s-2); flex-wrap:wrap; align-items:center; }
    .task .t-id { margin-left:auto; font-family:var(--font-mono); font-size:var(--t-xs); color:var(--muted); opacity:.8; }
    /* kobo-62 — checklist mini progress bar (was ☑N/M text). */
    .check-bar { display:inline-flex; align-items:center; gap:var(--s-2); }
    .check-track { width:56px; height:5px; background:var(--field-bg); border:1px solid var(--line); border-radius:var(--r-pill); overflow:hidden; }
    .check-fill { display:block; height:100%; background:var(--epic); }
    .check-count { font-size:var(--t-xs); color:var(--muted); font-variant-numeric:tabular-nums; }
    /* kobo-62 — detail modal meta row (dept / parent / wait moved off the face). */
    #detail-meta { display:flex; gap:var(--s-2); flex-wrap:wrap; margin-bottom:var(--s-5); }
    #detail-meta[hidden] { display:none; }
    /* kobo-190 — approve-lane decision block (human gate, gold like the lane). */
    #detail-approve[hidden] { display:none; }
    .approve-box { border:1px solid var(--link); border-radius:var(--r-md); padding:var(--s-3) var(--s-4); margin-bottom:var(--s-5); background:var(--field-bg); }
    .approve-head { color:var(--link); font-size:var(--t-sm); margin-bottom:var(--s-2); }
    .approve-line { color:var(--fg); }
    .approve-title { color:var(--muted); margin-top:2px; }
    .approve-rev { color:var(--ok); font-size:var(--t-sm); margin-top:2px; }
    .approve-prose { color:var(--fg); white-space:pre-wrap; }
    .approve-link { display:inline-block; margin-top:var(--s-2); color:var(--link); }
    .approve-actions { margin-top:var(--s-3); display:flex; align-items:center; gap:var(--s-3); }
    .approve-btn { font-size:12px; padding:6px 12px; border-radius:8px; border:1px solid var(--link); color:var(--link); background:var(--field-bg); cursor:pointer; }
    .approve-btn:hover { border-color:var(--fg); }
    .approve-btn:disabled { opacity:.55; cursor:default; }
    .approve-msg.ok { color:var(--ok); } .approve-msg.err { color:var(--bad); }
    .task .t-na { color:var(--accent); font-size:var(--t-sm); margin-top:var(--s-2); }
    .task .t-actions { margin-top:8px; display:flex; justify-content:flex-end; }
    .archive-btn { font-size:11px; padding:3px 9px; border-radius:8px; border:1px solid var(--bd-ok); color:var(--ok); background:var(--field-bg); cursor:pointer; }
    .archive-btn:hover { border-color:var(--ok); }
    .archive-btn:disabled { opacity:.55; cursor:default; }
    /* kobo-50 — mark-done button in the modal write section (pairs with archive). */
    .done-btn { align-self:flex-start; font-size:12px; padding:6px 12px; border-radius:8px; border:1px solid var(--bd-ok); color:var(--ok); background:var(--field-bg); cursor:pointer; }
    .done-btn:hover { border-color:var(--ok); }
    .done-btn:disabled { opacity:.55; cursor:default; }
    /* kobo-198 — a long single pill (block-reason / parent-not-found carries free
       text) is white-space:nowrap, so with no cap its min-content forces .col wide →
       the whole board grid blows past its track and text bleeds past the column edge.
       Cap at the container width + ellipsis so an over-long pill clamps instead of
       pushing the grid (short pills are unaffected — they never hit 100%). */
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 7px; white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
    .pill.dept { color:var(--accent); } .pill.epic { color:var(--epic); } .pill.assignee { color:var(--ok); }
    .pill.pr { color:var(--warn); } .pill.wait { color:var(--warn); border-color:var(--bd-warn); }
    .pill.check { color:var(--epic); }
    .pill.attn { color:var(--bad); border-color:var(--bd-bad); }
    /* kobo-184 — state badge in the detail modal header. Same lane tokens as the
       board column (.col-* h2) + card left-border (.task.st-*) so state reads the
       same everywhere. Uppercase + weight makes it the prominent lead pill. */
    .pill.state { font-weight:700; text-transform:uppercase; letter-spacing:.04em; font-size:var(--t-xs); }
    .pill.state.st-backlog { color:var(--muted); }
    .pill.state.st-todo { color:var(--warn); border-color:var(--bd-warn); }
    .pill.state.st-ready { color:var(--ok); border-color:var(--bd-ok); }
    .pill.state.st-in-progress { color:var(--accent); border-color:var(--bd-accent); }
    .pill.state.st-review { color:var(--epic); border-color:var(--bd-epic); }
    .pill.state.st-blocked { color:var(--bad); border-color:var(--bd-bad); }
    .pill.state.st-done { color:var(--ok); border-color:var(--bd-ok); }
    .pill.state.st-rejected { color:var(--warn); border-color:var(--bd-warn); }
    /* kobo-47 kanban c3 — epic rollup badge, parent chip (click = filter family). */
    .pill.epic-badge { color:var(--epic); border-color:var(--bd-epic); }
    .pill.epic-badge.all-done { color:var(--ok); border-color:var(--bd-ok); }
    .pill.parent-chip { color:var(--accent); }
    .pill.parent-chip.unresolved { color:var(--muted); }
    .pill.epic-badge:hover, .pill.parent-chip:hover { border-color:var(--accent); }
    .pill.epic-badge:focus-visible, .pill.parent-chip:focus-visible { outline:none; box-shadow:0 0 0 2px var(--accent); }
    .family-bar { display:flex; align-items:center; gap:10px; margin-bottom:10px; padding:6px 11px; border:1px solid var(--bd-epic); border-radius:10px; background:var(--col); color:var(--muted); font-size:12px; }
    .family-bar[hidden] { display:none; }
    .family-bar .fam-root { color:var(--epic); }
    .family-clear { font-size:11px; padding:2px 9px; border-radius:8px; color:var(--accent); }
    /* kobo-128 — @mentions decision queue at the board head (Tony's reply inbox). */
    .mentions-bar { margin-bottom:var(--s-4); border:1px solid var(--bd-warn); border-radius:var(--r-lg); background:var(--col); padding:var(--s-4) var(--s-5); }
    .mentions-bar[hidden] { display:none; }
    .mentions-bar .mentions-head { display:flex; align-items:center; gap:var(--s-3); color:var(--warn); font-weight:600; font-size:var(--t-sm); margin-bottom:var(--s-3); }
    .mentions-bar .mentions-head .count { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
    .mention-row { display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; padding:var(--s-2) 0; border-top:1px dashed var(--line); }
    .mention-row:first-of-type { border-top:0; }
    .mention-id { font-family:var(--font-mono); font-size:var(--t-xs); color:var(--accent); }
    .mention-who { font-size:var(--t-xs); color:var(--warn); font-weight:600; }
    .mention-txt { flex:1 1 240px; min-width:0; color:var(--fg); font-size:var(--t-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mention-reply-in { flex:1 1 160px; min-width:120px; }
    .mention-reply-btn { font-size:var(--t-xs); padding:3px 10px; border-radius:8px; border:1px solid var(--bd-warn); color:var(--warn); background:var(--field-bg); cursor:pointer; }
    .mention-reply-btn:hover { border-color:var(--warn); }
    .mention-reply-btn:disabled { opacity:.55; cursor:default; }
    /* kobo-128 — parent-badge: open ask-subcards routed to Tony (⧉ N open →tony);
       once answered (done) the badge flips to a review-colored "answered ✓". */
    .pill.q-open { color:var(--warn); border-color:var(--bd-warn); }
    .pill.q-answered { color:var(--ok); border-color:var(--bd-ok); }
    .timeline { max-height:72vh; overflow:auto; }
    /* kobo-63 — worklog timeline aligned to Foundation tokens (--s-*/--t-*/--r-*)
       + the maw-pane palette (kobo-71). Each row carries its author's pane color as
       a compact avatar (initials, avatarText auto-contrast) + a matching left accent,
       so oracles read apart at a glance. Color is SUPPLEMENTARY — the full oracle
       name is always shown (color-not-only). Read-only: feed/flow unchanged. */
    .entry { display:flex; gap:var(--s-3); padding:var(--s-3) var(--s-2); border-bottom:1px solid var(--line); border-left:2px solid transparent; }
    .entry:last-child { border-bottom:0; }
    .entry .e-avatar { flex:0 0 auto; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; letter-spacing:.02em; }
    .entry .e-main { flex:1 1 auto; min-width:0; }
    .entry .e-head { display:flex; gap:var(--s-3); align-items:baseline; flex-wrap:wrap; }
    .entry .e-oracle { color:var(--fg); font-weight:600; }
    .entry .e-kind { color:var(--muted); font-size:var(--t-xs); border:1px solid var(--line); border-radius:var(--r-pill); padding:0 var(--s-2); }
    .entry .e-ts { color:var(--muted); font-size:var(--t-xs); margin-left:auto; font-variant-numeric:tabular-nums; }
    .entry .e-summary { color:var(--fg); font-size:var(--t-sm); margin-top:var(--s-1); line-height:1.5; white-space:pre-wrap; word-break:break-word; }
    .empty, .error { color:var(--muted); padding:18px; text-align:center; }
    .error { color:var(--bad); }
    .stack { display:flex; flex-direction:column; gap:16px; }
    .md { color:var(--fg); max-height:60vh; overflow:auto; font-size:13px; }
    .md h1,.md h2,.md h3,.md h4 { color:var(--accent); margin:14px 0 8px; line-height:1.3; }
    .md h1 { font-size:18px; } .md h2 { font-size:15px; } .md h3 { font-size:13px; } .md h4 { font-size:12px; color:var(--muted); }
    .md p { margin:8px 0; } .md ul,.md ol { margin:8px 0; padding-left:20px; } .md li { margin:3px 0; }
    .md code { background:var(--field-bg); border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
    .md pre { background:var(--field-bg); border:1px solid var(--line); border-radius:9px; padding:10px; overflow:auto; }
    .md pre code { background:none; border:0; padding:0; }
    .md blockquote { border-left:3px solid var(--line); margin:8px 0; padding:2px 0 2px 12px; color:var(--muted); }
    .md a { color:var(--link); } .md hr { border:0; border-top:1px solid var(--line); margin:12px 0; }
    .md strong { color:var(--fg); } .md em { color:var(--warn); }
    .md li.chk { list-style:none; display:flex; gap:8px; align-items:baseline; margin-left:-16px; }
    .md li.chk input { accent-color:var(--accent); margin:0; transform:translateY(2px); flex:0 0 auto; }
    .md li.chk .done { color:var(--muted); text-decoration:line-through; }
    /* kobo-60 — structured card-detail body: field lines → inner-card blocks,
       scope checklist → progress block. Foundation tokens (st, r, s, t scales).
       Color lives on the LEFT BORDER only; label + value text stay high-contrast
       (--muted / --fg) so meaning never rides on color alone (color-not-only, same
       proven pattern as the kobo-56 note bubbles). Escape-first: values go through
       escapeHtml→inlineMd. Prose reads sans; ids/code/labels stay mono. */
    #detail-body { font-family:var(--font-ui); }
    #detail-body code, #detail-body pre, #detail-body .field-label, #detail-body .scope-title { font-family:var(--font-mono); }
    .field { background:var(--col); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:var(--r-md); padding:var(--s-4) var(--s-5); margin:var(--s-3) 0; }
    .field-label { display:block; font-size:var(--t-xs); text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:700; margin-bottom:var(--s-1); }
    .field-val { color:var(--fg); font-size:var(--t-base); line-height:1.55; white-space:pre-wrap; word-break:break-word; }
    .field-val code { background:var(--field-bg); border:1px solid var(--line); border-radius:var(--r-xs); padding:1px 5px; }
    .field-val a { color:var(--accent); }
    .field-source { border-left-color:var(--st-source); }
    .field-premise { border-left-color:var(--st-premise); }
    .field-bug { border-left-color:var(--st-bug); }
    .field-accept { border-left-color:var(--st-accept); }
    .field-meta { border-left-color:var(--st-meta); }
    .scope-block { background:var(--col); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--s-4) var(--s-5); margin:var(--s-4) 0; }
    .scope-head { display:flex; align-items:center; gap:var(--s-4); margin-bottom:var(--s-3); }
    .scope-title { font-size:var(--t-xs); text-transform:uppercase; letter-spacing:.06em; color:var(--accent); font-weight:700; }
    .scope-prog { display:flex; align-items:center; gap:var(--s-3); margin-left:auto; }
    .scope-count { font-size:var(--t-xs); color:var(--muted); font-variant-numeric:tabular-nums; }
    .scope-bar { width:84px; height:6px; background:var(--field-bg); border:1px solid var(--line); border-radius:var(--r-pill); overflow:hidden; }
    .scope-fill { height:100%; background:var(--accent); }
    .scope-item { display:flex; gap:var(--s-3); align-items:baseline; padding:var(--s-1) 0; }
    .scope-item input { accent-color:var(--accent); margin:0; transform:translateY(1px); flex:0 0 auto; }
    .scope-item.done .scope-txt { color:var(--muted); text-decoration:line-through; }
    .scope-txt { color:var(--fg); }
    /* kobo-42 polish — hover/focus affordance so cards read as clickable, refined
       column headers + count chips, and an accent on the active detail panel.
       All token-driven so the light theme inherits the same treatment. */
    .task { transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
    .task:hover { border-color:var(--accent); box-shadow:0 6px 16px rgba(0,0,0,.28); transform:translateY(-1px); }
    .task:focus-visible { outline:none; border-color:var(--accent); box-shadow:0 0 0 2px var(--accent); }
    .col h2 { text-transform:uppercase; letter-spacing:.07em; border-bottom:1px solid var(--line); padding-bottom:8px; }
    .col h2 .count { background:var(--col); border:1px solid var(--line); border-radius:999px; padding:0 8px; font-size:11px; font-weight:600; }
    #detail-panel { border-left:3px solid var(--accent); }
    #detail-notes .notes-head { margin:14px 0 8px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
    /* kobo-141 — collapsible notes toggle: keep the notes-head look, add button reset + pointer. */
    #detail-notes .notes-toggle { display:block; background:none; border:0; padding:0; cursor:pointer; font:inherit; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
    #detail-notes .notes-toggle:hover, #detail-notes .notes-toggle:focus-visible { color:var(--fg); outline:none; }
    /* kobo-56 — comment/note timeline as author-coded bubbles (was flat monospace
       rows). Author identity is triple-encoded: avatar color + initials + full name
       (never color alone), so eq3/tony/patchwork/worker read apart. Color lives on
       the self-contained avatar circle + left border (not on text) → no dual-theme
       contrast risk; the name stays high-contrast --fg. Token-driven both themes. */
    #detail-notes .note { display:flex; gap:10px; padding:9px 12px; margin-bottom:10px; background:var(--col); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:10px; }
    #detail-notes .note:last-child { margin-bottom:2px; }
    #detail-notes .note-avatar { flex:0 0 auto; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; letter-spacing:.02em; }
    #detail-notes .note-main { flex:1 1 auto; min-width:0; }
    #detail-notes .note-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
    #detail-notes .note-author { font-weight:600; color:var(--fg); }
    #detail-notes .note-src { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0 7px; }
    #detail-notes .note-ts { color:var(--muted); font-size:11px; margin-left:auto; font-variant-numeric:tabular-nums; }
    /* kobo-115 — note body renders as markdown (.md), so prose rhythm comes from the
       .md scale, not pre-wrap. Tighten paragraph margins for the bubble; long notes
       clamp with a fade + show-more toggle so the timeline stays scannable. */
    #detail-notes .note-body { color:var(--fg); font-size:13px; word-break:break-word; }
    #detail-notes .note-body.md p { margin:6px 0; line-height:1.6; }
    #detail-notes .note-body.md p:first-child { margin-top:0; }
    #detail-notes .note-body.md p:last-child { margin-bottom:0; }
    #detail-notes .note-body.clamp { max-height:150px; overflow:hidden; -webkit-mask-image:linear-gradient(#000 72%, transparent); mask-image:linear-gradient(#000 72%, transparent); }
    #detail-notes .note-more { margin:4px 0 0; cursor:pointer; color:var(--link); background:none; border:0; font:inherit; font-size:12px; padding:0; }
    #detail-notes .note-more:hover, #detail-notes .note-more:focus-visible { text-decoration:underline; outline:none; }
    /* kobo-116 — inline note images: fit the modal, cap height so a big screenshot
       can't dominate the timeline; click the image to open it full-size (anchor). */
    #detail-notes .note-img-link { display:inline-block; margin:6px 0; }
    #detail-notes .note-img { display:block; max-width:100%; max-height:320px; height:auto; border:1px solid var(--line); border-radius:9px; }
    #detail-notes .note-img-link:focus-visible { outline:none; box-shadow:0 0 0 2px var(--accent); border-radius:9px; }
    /* kobo-141 — Comments thread: the ask/answer channel (Board Truth rule 10),
       distinct from notes. Reuses the note bubble look; adds threading indent +
       reply/resolve affordances + a resolved (dimmed) state. */
    #detail-comments { max-height:72vh; overflow-y:auto; } /* kobo-176: scroll cap (mirror .timeline) so a long thread can't run off-screen */
    #detail-comments .comments-head { margin:14px 0 8px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
    #detail-comments .cmt-resolved-toggle { display:block; background:none; border:0; padding:2px 0 8px; margin:0; font:inherit; font-size:12px; color:var(--muted); cursor:pointer; }
    #detail-comments .cmt-resolved-toggle:hover, #detail-comments .cmt-resolved-toggle:focus-visible { color:var(--link); }
    #detail-comments:not(.show-resolved) .cmt-foldable { display:none; } /* kobo-176: fold fully-resolved branches until toggled */
    #detail-comments .cmt { display:flex; gap:10px; padding:9px 12px; margin-bottom:10px; background:var(--col); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:10px; }
    #detail-comments .cmt.reply { /* indent set inline from clamped level (kobo-171) */ }
    #detail-comments .cmt-replytarget { align-self:flex-start; margin:2px 0 4px; padding:2px 8px; font-size:11px; line-height:1.4; color:var(--muted); background:var(--panel2, rgba(127,127,127,.12)); border:1px solid var(--border, rgba(127,127,127,.25)); border-radius:10px; cursor:pointer; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #detail-comments .cmt-replytarget:hover, #detail-comments .cmt-replytarget:focus-visible { color:var(--link); border-color:var(--link); }
    #detail-comments .cmt.cmt-flash { animation:cmtFlash 1.5s ease-out; }
    @keyframes cmtFlash { 0% { background:var(--link, #4aa3ff); } 12% { background:color-mix(in srgb, var(--link, #4aa3ff) 35%, transparent); } 100% { background:transparent; } }
    #detail-comments .cmt.resolved { opacity:.55; }
    #detail-comments .cmt-avatar { flex:0 0 auto; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; }
    #detail-comments .cmt-main { flex:1 1 auto; min-width:0; }
    #detail-comments .cmt-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
    #detail-comments .cmt-author { font-weight:600; color:var(--fg); }
    #detail-comments .cmt-resolved-badge { font-size:11px; color:var(--ok, #3fb950); border:1px solid var(--line); border-radius:999px; padding:0 7px; }
    #detail-comments .cmt-ts { color:var(--muted); font-size:11px; margin-left:auto; font-variant-numeric:tabular-nums; }
    #detail-comments .cmt-body { color:var(--fg); font-size:13px; word-break:break-word; }
    #detail-comments .cmt-body.md p { margin:6px 0; line-height:1.6; }
    #detail-comments .cmt-body.md p:first-child { margin-top:0; }
    #detail-comments .cmt-body.md p:last-child { margin-bottom:0; }
    #detail-comments .cmt-actions { display:flex; gap:8px; margin-top:6px; }
    #detail-comments .cmt-act { cursor:pointer; color:var(--link); background:none; border:0; font:inherit; font-size:12px; padding:0; }
    #detail-comments .cmt-act:hover, #detail-comments .cmt-act:focus-visible { text-decoration:underline; outline:none; }
    #detail-comments .cmt-reply-box { display:flex; gap:6px; margin:6px 0 0 26px; }
    #detail-comments .cmt-reply-box input { flex:1 1 auto; min-width:0; }
    /* kobo-44: card detail as a modal overlay (was an inline sidebar panel). */
    /* kobo-136 — detail is now a right-side DRAWER: full height (family tree +
       note thread get room), board stays visible behind. Same ids + open/close
       logic (openModal/closeDetail untouched) — presentation only. */
    .overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:stretch; justify-content:flex-end; padding:0; z-index:50; }
    .overlay[hidden] { display:none; }
    .modal { width:min(620px, 100%); height:100%; max-height:none; overflow:auto; margin:0; padding:var(--s-8); border-radius:0; border-top:0; border-right:0; border-bottom:0; box-shadow:-16px 0 40px rgba(0,0,0,.5); animation:drawer-in .18s ease; }
    @keyframes drawer-in { from { transform:translateX(28px); opacity:.6; } to { transform:none; opacity:1; } }
    @media (prefers-reduced-motion: reduce) { .modal { animation:none; } }
    .modal .md { max-height:none; }
    /* kobo-110 — detail modal reading rhythm: title stands out + wraps, sections
       separated by space + a hairline so the eye flows title → meta → body → actions. */
    #detail-title { font-size:var(--t-xl); font-weight:600; line-height:1.35; color:var(--fg); overflow-wrap:anywhere; margin-bottom:var(--s-5); }
    #detail-body:not(:empty) { padding-top:var(--s-5); border-top:1px solid var(--line); }
    #detail-body p { line-height:1.65; margin:var(--s-4) 0; }
    #detail-body p:first-child { margin-top:0; }
    #detail-close { cursor:pointer; color:var(--muted); background:none; border:0; font:inherit; line-height:1; padding:2px 6px; border-radius:6px; }
    #detail-close:hover, #detail-close:focus-visible { color:var(--fg); outline:none; box-shadow:0 0 0 2px var(--accent); }
    /* kobo-136 — drawer dependency chips: what this card waits on (blockedBy /
       missing, ADR 0003) + reverse (cards this one unblocks). Reuses .pill. */
    #detail-deps { display:flex; gap:var(--s-2); flex-wrap:wrap; margin-bottom:var(--s-5); }
    #detail-deps[hidden] { display:none; }
    .pill.dep-blocks { color:var(--ok); border-color:var(--bd-ok); }
    /* kobo-136 — drawer family tree: root → descendants (DFS), current card marked.
       State rides a colored dot + the id/title text (color-not-only via position). */
    #detail-family[hidden] { display:none; }
    .fam-tree { margin:0 0 var(--s-5); padding:var(--s-4) var(--s-5); background:var(--col); border:1px solid var(--line); border-radius:var(--r-lg); }
    .fam-tree .ft-head { font-family:var(--font-mono); font-size:var(--t-xs); text-transform:uppercase; letter-spacing:.06em; color:var(--epic); font-weight:700; margin-bottom:var(--s-3); }
    .ft-node { display:flex; align-items:baseline; gap:var(--s-3); padding:2px var(--s-2); font-size:var(--t-sm); border-radius:var(--r-xs); min-width:0; }
    .ft-node[role=button] { cursor:pointer; }
    .ft-node[role=button]:hover, .ft-node[role=button]:focus-visible { background:var(--field-bg); outline:none; }
    .ft-node.current { background:var(--field-bg); border-left:2px solid var(--accent); }
    .ft-node .ft-dot { flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:var(--muted); transform:translateY(-1px); }
    .ft-dot.st-todo { background:var(--warn); } .ft-dot.st-in-progress { background:var(--accent); }
    .ft-dot.st-review { background:var(--epic); } .ft-dot.st-approve { background:var(--link); } .ft-dot.st-done { background:var(--ok); }
    .ft-dot.st-blocked { background:var(--bad); } .ft-dot.st-rejected { background:var(--warn); }
    .ft-node .ft-id { flex:0 0 auto; font-family:var(--font-mono); color:var(--accent); }
    .ft-node .ft-state { flex:0 0 auto; color:var(--muted); font-size:var(--t-xs); }
    .ft-node .ft-title { flex:1 1 auto; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ft-node.current .ft-title { color:var(--fg); }
    /* kobo-143 v2 — breadcrumb path (root › … › current) */
    .fam-tree .ft-crumb { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); margin-bottom:var(--s-3); font-family:var(--font-mono); font-size:var(--t-xs); }
    .ft-crumb .ft-crumb-sep { color:var(--muted); }
    .ft-crumb .ft-crumb-id { color:var(--accent); border-radius:var(--r-xs); padding:0 4px; }
    .ft-crumb .ft-crumb-id.current { color:var(--fg); font-weight:700; background:var(--field-bg); }
    .ft-crumb .ft-crumb-id[role=button]:hover, .ft-crumb .ft-crumb-id[role=button]:focus-visible { background:var(--field-bg); outline:none; }
    /* kobo-143 v2 — collapse toggle + nested children container + owner/comment badges */
    .ft-node .ft-toggle { flex:0 0 auto; width:12px; text-align:center; color:var(--muted); cursor:pointer; user-select:none; font-size:10px; }
    .ft-node .ft-toggle.ft-toggle-spacer { cursor:default; }
    .ft-node .ft-toggle[role=button]:hover, .ft-node .ft-toggle[role=button]:focus-visible { color:var(--fg); outline:none; }
    .ft-children[hidden] { display:none; }
    .ft-node .ft-owner { flex:0 0 auto; font-size:var(--t-xs); border:1px solid var(--line); border-radius:999px; padding:0 7px; color:var(--fg); }
    .ft-node .ft-owner.unassigned { color:var(--muted); border-style:dashed; }
    .ft-node .ft-cmt { flex:0 0 auto; font-size:var(--t-xs); color:var(--muted); }
    .ft-node .ft-cmt.has-open { color:var(--warn); font-weight:600; }
    /* kobo-48 web write — +subtask + comment box inside the modal. */
    .detail-write { margin-top:14px; border-top:1px solid var(--line); padding-top:12px; display:flex; flex-direction:column; gap:12px; }
    .write-row { display:flex; flex-direction:column; gap:6px; }
    .write-row > label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .write-row .row { display:flex; gap:8px; align-items:flex-start; }
    .write-row input[type=text], .write-row textarea { flex:1; background:var(--field-bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:7px 9px; font:inherit; }
    .write-row input[type=text]:focus, .write-row textarea:focus { outline:none; border-color:var(--accent); }
    .write-row textarea { resize:vertical; min-height:52px; }
    .write-row button { white-space:nowrap; }
    .write-row button:disabled { opacity:.55; cursor:default; }
    .write-msg { font-size:12px; min-height:16px; }
    .write-msg.err { color:var(--bad); } .write-msg.ok { color:var(--ok); }
    /* kobo-49 c5 — tab shell (Kanban / Worklog / Presence). */
    .tabs { display:flex; gap:var(--s-1); margin-bottom:var(--s-7); border-bottom:1px solid var(--line); flex-wrap:wrap; }
    .tab { background:none; border:0; border-bottom:2px solid transparent; border-radius:8px 8px 0 0; padding:8px 16px; color:var(--muted); cursor:pointer; }
    .tab:hover { color:var(--fg); }
    .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .tab:focus-visible { outline:none; box-shadow:0 0 0 2px var(--accent); }
    .tab .tab-count { font-size:11px; color:var(--muted); margin-left:6px; }
    .tabpanel[hidden] { display:none; }
    .timeline-full { max-height:78vh; }
    /* kobo-49 c5 — Presence tab, derived from the worklog feed (no /api/presence). */
    /* kobo-64 — Presence polish: Foundation tokens + maw-pane per-oracle avatar
       (same authorColor/avatarText contract as note bubbles). Presentation only;
       roster/derive/status logic unchanged. */
    .presence-note { font-size:var(--t-sm); color:var(--muted); background:var(--col); border:1px solid var(--line); border-radius:var(--r-md); padding:var(--s-3) var(--s-5); margin-bottom:var(--s-6); line-height:1.5; }
    .presence-note b { color:var(--warn); }
    /* kobo-103 — Presence as a responsive GRID (rows were hard to scan). Each cell
       is one oracle card; the status is an explicit active/idle badge, not just a
       dot. Data/derive unchanged (roster + worklog fold) — presentation only. */
    .presence-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:var(--s-4); align-items:start; }
    .presence-cell { display:flex; flex-direction:column; gap:var(--s-2); padding:var(--s-4) var(--s-5); border:1px solid var(--line); border-radius:var(--r-md); background:var(--card); }
    .presence-cell.is-active { border-left:3px solid var(--ok); }
    .presence-cell.is-idle-work { border-left:3px solid var(--warn); }
    .presence-cell.is-error { border-left:3px solid var(--bad); } /* kobo-111 — turn-ending API error */
    .presence-cell .p-head { display:flex; align-items:center; gap:var(--s-3); }
    .presence-cell .p-avatar { flex:0 0 auto; width:26px; height:26px; border-radius:var(--r-pill); display:flex; align-items:center; justify-content:center; font-size:var(--t-xs); font-weight:700; letter-spacing:.02em; }
    .presence-cell .p-oracle { color:var(--accent); font-weight:600; font-size:var(--t-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .presence-cell .p-badge { margin-left:auto; flex:0 0 auto; font-size:var(--t-xs); font-weight:600; padding:2px var(--s-3); border-radius:var(--r-pill); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
    .presence-cell .p-badge.active { color:var(--ok); border-color:var(--ok); }
    .presence-cell .p-badge.idle { color:var(--st-meta); }
    .presence-cell .p-badge.idle-work { color:var(--warn); border-color:var(--warn); }
    .presence-cell .p-badge.error { color:var(--bad); border-color:var(--bad); } /* kobo-111 */
    .presence-cell .p-role { color:var(--muted); font-size:var(--t-sm); }
    .presence-cell .p-when { color:var(--muted); font-size:var(--t-sm); }
    .presence-cell .p-count { color:var(--muted); font-size:var(--t-xs); }
    .presence-cell .p-status { color:var(--st-meta); font-size:var(--t-sm); }
    .presence-cell .p-last { color:var(--fg); font-size:var(--t-sm); white-space:pre-wrap; word-break:break-word; }
    /* kobo-105 — idle-with-work: the held claims/cards behind the ⚠️ badge */
    .presence-cell .p-held { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); margin-top:var(--s-1); font-size:var(--t-xs); }
    .presence-cell .p-held-label { color:var(--warn); font-weight:600; }
    .presence-cell .p-held-item { color:var(--fg); background:var(--col); border:1px solid var(--line); border-radius:var(--r-sm); padding:0 var(--s-2); font-variant-numeric:tabular-nums; }
    /* kobo-104 — per-pane model + context% sub-rows */
    .presence-cell .p-panes { display:flex; flex-direction:column; gap:var(--s-1); margin-top:var(--s-1); padding-top:var(--s-2); border-top:1px dashed var(--line); }
    .presence-cell .p-pane-row { display:flex; align-items:baseline; gap:var(--s-2); font-size:var(--t-xs); }
    .presence-cell .p-pane-row.is-stale { opacity:.55; }
    .presence-cell .p-pane-id { flex:0 0 auto; color:var(--st-meta); font-variant-numeric:tabular-nums; }
    .presence-cell .p-pane-model { flex:1 1 auto; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .presence-cell .p-pane-ctx { flex:0 0 auto; color:var(--muted); font-variant-numeric:tabular-nums; }
    /* kobo-109 — per-pane busy/idle badge (feed recency per %N), so one oracle's
       active + idle panes read apart. green=busy, muted=idle; text label, not color-only. */
    .presence-cell .p-pane-badge { flex:0 0 auto; margin-left:auto; font-size:var(--t-xs); font-weight:600; padding:0 var(--s-2); border-radius:var(--r-pill); border:1px solid var(--line); color:var(--st-meta); white-space:nowrap; }
    .presence-cell .p-pane-badge.busy { color:var(--ok); border-color:var(--ok); }
    .presence-cell .p-pane-badge.error { color:var(--bad); border-color:var(--bad); } /* kobo-111 */
    .presence-cell .p-pane-row.is-pane-busy .p-pane-id { color:var(--ok); }
    .presence-cell .p-pane-row.is-pane-error .p-pane-id { color:var(--bad); }
    @media (prefers-reduced-motion: reduce) { .task, body { transition:none; } }
    @media (max-width: 880px) { body { padding:12px; } .layout { grid-template-columns: 1fr; } .board { grid-template-columns: 1fr; } .timeline, .md { max-height:none; } }
    /* kobo-57 new-version reload banner — kobo-61 folds it into the header zone:
       token-aligned presentation only (padding/gap/margin → --s-*), logic (version
       poll + per-version dismiss) untouched. Breaks out to full width above the
       header via negative body-padding margin (body pad = --s-9). */
    #update-banner { position:sticky; top:0; z-index:50; display:flex; align-items:center; gap:var(--s-5); margin:calc(-1 * var(--s-9)) calc(-1 * var(--s-9)) var(--s-7); padding:var(--s-4) var(--s-9); background:var(--card); border-bottom:1px solid var(--accent); color:var(--fg); box-shadow:0 6px 16px rgba(0,0,0,.25); }
    #update-banner[hidden] { display:none; }
    #update-banner span { flex:1; }
    #update-banner #update-reload { border-color:var(--accent); color:var(--accent); }
    #update-banner #update-dismiss { border-color:var(--line); color:var(--muted); }
    @media (max-width: 880px) { #update-banner { margin:-12px -12px 12px; padding:10px 12px; } }
  </style>
</head>
<body>
  <div id="update-banner" role="status" hidden>
    <span>🔄 New version deployed — reload to get the latest board.</span>
    <button type="button" id="update-reload">reload</button>
    <button type="button" id="update-dismiss" aria-label="dismiss">✕</button>
  </div>
  <header>
    <div class="brand">
      <h1><span class="logo" aria-hidden="true">◈</span> maw company <span class="co" id="co-name">—</span></h1>
      <div class="sub">read-only board + worklog timeline · <code id="status">loading…</code></div>
    </div>
    <div class="controls">
      <label class="switcher">company <input id="company" placeholder="pgw" /></label>
      <button id="theme" type="button" title="toggle light/dark" aria-label="toggle theme">🌙</button>
      <button id="refresh" type="button">refresh</button>
    </div>
  </header>
  <nav class="tabs" role="tablist" aria-label="views">
    <button type="button" class="tab active" data-tab="kanban" role="tab" aria-selected="true">Kanban</button>
    <button type="button" class="tab" data-tab="state" role="tab" aria-selected="false">State<span class="tab-count" id="tab-count-state"></span></button>
    <button type="button" class="tab" data-tab="worklog" role="tab" aria-selected="false">Worklog<span class="tab-count" id="tab-count-worklog"></span></button>
    <button type="button" class="tab" data-tab="presence" role="tab" aria-selected="false">Presence<span class="tab-count" id="tab-count-presence"></span></button>
  </nav>
  <main>
    <section class="tabpanel" data-tab="kanban" role="tabpanel">
      <div class="card">
        <div class="mentions-bar" id="mentions-bar" hidden></div>
        <div class="family-bar" id="family-bar" hidden></div>
        <div class="assignee-bar" id="assignee-bar" hidden></div>
        <div class="board-toolbar"><button class="reveal-parking" id="reveal-parking" type="button" aria-expanded="false">⊕ แสดง parking</button></div>
        <div class="board">
          <div class="col col-backlog"><h2><button class="col-chevron" type="button" data-col="backlog" aria-label="toggle backlog">▸</button><span>Backlog</span><span class="count" id="c-backlog">0</span></h2><div id="backlog"></div></div>
          <div class="col col-todo"><h2><span>Todo</span><span class="count" id="c-todo">0</span></h2><div id="todo"></div></div>
          <div class="col col-ready"><h2><span>Ready</span><span class="count" id="c-ready">0</span></h2><div id="ready"></div></div>
          <div class="col col-in-progress"><h2><span>In&nbsp;progress</span><span class="count" id="c-in-progress">0</span></h2><div id="in-progress"></div></div>
          <div class="col col-review"><h2><span>Review</span><span class="count" id="c-review">0</span></h2><div id="review"></div></div>
          <div class="col col-approve"><h2><span>Approve</span><span class="count" id="c-approve">0</span></h2><div id="approve"></div></div>
          <div class="col col-blocked"><h2><span>⚑&nbsp;Blocked</span><span class="count" id="c-blocked">0</span></h2><div id="blocked"></div></div>
          <div class="col col-done"><h2><span>Done</span><span class="count" id="c-done">0</span></h2><div id="done"></div></div>
          <div class="col col-rejected"><h2><button class="col-chevron" type="button" data-col="rejected" aria-label="toggle rejected">▸</button><span>Rejected</span><span class="count" id="c-rejected">0</span></h2><div id="rejected"></div></div>
        </div>
      </div>
    </section>
    <section class="tabpanel" data-tab="state" role="tabpanel" hidden>
      <div class="card" id="state-panel">
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted)">coordination state</h2>
        <div class="md" id="state-md"></div>
      </div>
    </section>
    <section class="tabpanel" data-tab="worklog" role="tabpanel" hidden>
      <div class="card">
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted)">worklog timeline</h2>
        <div class="timeline timeline-full" id="timeline"></div>
      </div>
    </section>
    <section class="tabpanel" data-tab="presence" role="tabpanel" hidden>
      <div class="card">
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted)">presence · who's around</h2>
        <div id="presence"></div>
      </div>
    </section>
  </main>
  <div class="overlay" id="detail-overlay" hidden>
    <div class="card modal" id="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title" tabindex="-1">
      <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between">card detail <button type="button" id="detail-close" aria-label="close detail">✕</button></h2>
      <div id="detail-title"></div>
      <div id="detail-meta"></div>
      <div id="detail-approve" hidden></div>
      <div id="detail-deps" hidden></div>
      <div id="detail-family" hidden></div>
      <div class="md" id="detail-body"></div>
      <div id="detail-comments"></div>
      <div id="detail-notes"></div>
      <div class="detail-write" id="detail-write"></div>
    </div>
  </div>
<script>
const $ = (id) => document.getElementById(id);
const companyInput = $('company');
const statusEl = $('status');

// kobo-57 cache-bust — the version this page shell loaded with. GET /api/version
// returns the server's live version; when they diverge, a deploy has happened
// and this tab is stale → offer a reload (honest: the user clicks, we never
// auto-refresh mid-work). Dismiss is per-version so a dismissed banner doesn't
// nag until the NEXT deploy.
const APP_VERSION = '${VERSION_TOKEN}';
let dismissedVersion = null;
async function checkVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    const live = d && d.version;
    const banner = $('update-banner');
    if (live && live !== APP_VERSION && live !== dismissedVersion) banner.hidden = false;
  } catch (e) { /* offline/transient — try again next poll */ }
}
$('update-reload').addEventListener('click', () => location.reload());
$('update-dismiss').addEventListener('click', async () => {
  $('update-banner').hidden = true;
  try { const r = await fetch('/api/version', { cache: 'no-store' }); dismissedVersion = r.ok ? (await r.json()).version : null; } catch (e) { /* ignore */ }
});

function text(v) { return v == null ? '' : String(v); }
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = String(txt); return e; }
function currentCompany() { return (companyInput.value || '').trim(); }

// kobo-47 kanban c3 — epic containment is DERIVED for display. The board already
// receives every active card via GET /api/tasks (each carries its containment
// parent in its epic field, plus state + notes), so rollup/parent-chip/child-notes are
// computed client-side from that one payload. When the backend projection (c2)
// starts sending richer fields (task.rollup / task.epicParent / task.childNotes —
// e.g. archived-parent detection, notes from swept-done children), we PREFER them
// and fall back to the client derivation. Same spec shape either way.
let taskIndex = { byId: new Map(), childrenOf: new Map() };
let lastTasks = [];
let lastEntries = []; // cached worklog feed — powers the Worklog + Presence tabs (kobo-49)
let lastRoster = []; // cached company roster (GET /api/roster) — authoritative Presence membership (kobo-50)
let lastHeld = {}; // cached { oracle → held work } from /api/roster (kobo-105) — idle-with-work signal
let lastPresence = []; // cached per-pane presence rows (GET /api/presence) — model + ctx% overlay (kobo-104)
let lastState = null; // cached /api/state — renders in the State tab (kobo-127)
let familyFilter = null; // root card id while filtering to one family, else null
let assigneeFilter = null; // assignee name while filtering to one owner, else null (kobo-127)
let doneExpanded = false; // Done lane shows only the 5 newest until "show all" (kobo-127)

function buildIndex(tasks) {
  const byId = new Map();
  const childrenOf = new Map();
  for (const t of tasks) byId.set(t.id, t);
  for (const t of tasks) {
    if (t.epic) { if (!childrenOf.has(t.epic)) childrenOf.set(t.epic, []); childrenOf.get(t.epic).push(t); }
  }
  taskIndex = { byId: byId, childrenOf: childrenOf };
}

// Derived N/M rollup — mirrors store.epicRollup: null when the card has no
// children (a plain card, no badge). Prefer a server-sent task.rollup.
// kobo-127 §5 (verify): childrenOf is keyed on the DIRECT epic parent
// (buildIndex), so this counts DIRECT children only — a grandchild under a
// sub-epic rolls up to that sub-epic, not to the grandparent. Correct for the
// nested-sub-epic layout (Board Truth rule 8); no deep-count bug to fix.
function rollupOf(task) {
  if (task.rollup && typeof task.rollup.total === 'number') return task.rollup;
  const kids = taskIndex.childrenOf.get(task.id) || [];
  if (!kids.length) return null;
  const done = kids.filter((c) => c.state === 'done').length;
  return { done: done, total: kids.length, allDone: done === kids.length };
}

// Parent reference for the "↳ <parent-id>" chip — mirrors store.resolveEpicParent.
// Prefer server task.epicParent (knows archived vs. truly-missing); else derive:
// a parent present in the active payload = resolved, absent = plain backward-compat
// tag (client-side can't tell archived from deleted — that precision arrives w/ c2).
function parentRefOf(task) {
  if (!task.epic) return null;
  if (task.epicParent && typeof task.epicParent === 'object') return task.epicParent;
  const parent = taskIndex.byId.get(task.epic);
  return { id: task.epic, resolved: !!parent, archived: false };
}

// Notes aggregated from every child card, oldest-first, each tagged with its
// source child id (spec §Comment: parent modal รวม notes ลูก, tag ว่ามาจาก sub ไหน).
// Prefer a server-sent task.childNotes (can include swept-done children).
function childNotesOf(task) {
  if (Array.isArray(task.childNotes)) return task.childNotes;
  const kids = taskIndex.childrenOf.get(task.id) || [];
  const out = [];
  for (const k of kids) for (const n of (k.notes || [])) out.push(Object.assign({}, n, { from: k.id }));
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

// Family = root card + all transitive descendants (BFS over containment).
function familyMembers(rootId) {
  const members = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of (taskIndex.childrenOf.get(cur) || [])) {
      if (!members.has(child.id)) { members.add(child.id); queue.push(child.id); }
    }
  }
  return members;
}

// Make a meta pill act as a button: pointer + keyboard-reachable, and stopPropagation
// so activating it filters instead of opening the card's detail modal.
function makeChip(node, onActivate) {
  node.style.cursor = 'pointer';
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  node.addEventListener('click', (ev) => { ev.stopPropagation(); onActivate(); });
  node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); onActivate(); } });
}

// Clicking an epic badge or a parent chip filters the board to that family. Re-render
// from the cached payload (no refetch) — the poll keeps lastTasks fresh underneath.
function setFamilyFilter(rootId) { familyFilter = rootId; renderBoard(lastTasks); }
function clearFamilyFilter() { familyFilter = null; renderBoard(lastTasks); }

// kobo-127 — clicking an assignee chip filters the board to that owner (re-render
// from cache, same as family filter). Independent of the family filter (both can
// be active); each has its own clear bar.
function setAssigneeFilter(name) { assigneeFilter = name; renderBoard(lastTasks); }
function clearAssigneeFilter() { assigneeFilter = null; renderBoard(lastTasks); }

function updateFamilyBar() {
  const bar = $('family-bar');
  if (!familyFilter) { bar.hidden = true; bar.replaceChildren(); return; }
  const fam = familyMembers(familyFilter);
  bar.replaceChildren();
  const label = el('span', '', '👪 filtering family ');
  label.appendChild(el('span', 'fam-root', familyFilter));
  label.appendChild(document.createTextNode(' · ' + fam.size + ' card' + (fam.size === 1 ? '' : 's')));
  bar.appendChild(label);
  const clear = el('button', 'family-clear', '✕ clear');
  clear.type = 'button';
  clear.addEventListener('click', clearFamilyFilter);
  bar.appendChild(clear);
  bar.hidden = false;
}

function updateAssigneeBar() {
  const bar = $('assignee-bar');
  if (!assigneeFilter) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.replaceChildren();
  const label = el('span', '', '👤 filtering owner ');
  label.appendChild(el('span', 'fam-root', '@' + assigneeFilter));
  bar.appendChild(label);
  const clear = el('button', 'family-clear', '✕ clear');
  clear.type = 'button';
  clear.addEventListener('click', clearAssigneeFilter);
  bar.appendChild(clear);
  bar.hidden = false;
}

// "X รอ Y" — derived, never stored (ADR §4): by≠assignee · state≠done.
function waitFor(task) {
  if (task.assignee && task.by && task.by !== task.assignee && task.state !== 'done') {
    return task.by + '→' + task.assignee;
  }
  return null;
}

// kobo-62 — card metadata relocated OFF the board face into the detail modal:
// dept · parent-chip (↳ epic, click = filter family) · wait (X→Y). The parent-chip
// keeps its filter action here; family-filter from the BOARD stays on the epic badge.
function renderDetailMeta(task) {
  const bar = $('detail-meta');
  bar.replaceChildren();
  const sb = stateBadge(task); // kobo-184 — prominent lead pill: card's stage at a glance
  bar.appendChild(el('span', sb.cls, sb.label));
  if (task.dept) bar.appendChild(el('span', 'pill dept', task.dept));
  const pref = parentRefOf(task);
  if (pref) {
    const chip = el('span', 'pill parent-chip' + (pref.resolved ? '' : ' unresolved'), '↳ ' + pref.id + (pref.archived ? ' (archived)' : ''));
    chip.title = pref.archived ? 'parent archived · click to filter this family' : (pref.resolved ? 'containment parent · click to filter this family' : 'parent id not on the board (backward-compat tag) · click to filter');
    makeChip(chip, () => { closeDetail(); setFamilyFilter(pref.id); });
    bar.appendChild(chip);
  }
  const wf = waitFor(task);
  if (wf) bar.appendChild(el('span', 'pill wait', '⏳ ' + wf));
  bar.hidden = !bar.childNodes.length;
}
// kobo-62 — assignee avatar (core face). Reuses the maw-pane color hash + kobo-71
// auto-contrast text; initials + title=full name keep it color-not-only. Unassigned
// = a muted dashed circle so "no owner" still reads without color.
function assigneeAvatar(name) {
  if (!name) { const a = el('div', 't-avatar unassigned', '·'); a.title = 'unassigned'; return a; }
  const color = authorColor(name);
  const a = el('div', 't-avatar', authorInitials(name));
  a.style.background = color;
  a.style.color = avatarText(color);
  a.title = '@' + name;
  return a;
}
// kobo-127 — assignee CHIP for the card face: full name + per-person color (same
// hash palette as the avatar) + click-to-filter. Color stays supplementary (the
// full name is always shown → color-not-only). Unassigned = a muted dashed chip
// with no filter action.
function assigneeChip(name) {
  if (!name) { const c = el('span', 'pill assignee-chip unassigned', 'unassigned'); c.title = 'no owner'; return c; }
  const color = authorColor(name);
  const chip = el('span', 'pill assignee-chip', name);
  chip.style.background = color;
  chip.style.color = avatarText(color);
  chip.title = 'click to filter @' + name;
  makeChip(chip, () => setAssigneeFilter(name));
  return chip;
}
// kobo-62 — checklist as a mini progress BAR (was "☑ N/M" text). Reuses the
// scope-bar visual language from kobo-60; aria makes the ratio non-visual too.
function checklistBar(done, total) {
  const wrap = el('span', 'check-bar');
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-label', done + ' of ' + total + ' checklist done');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', String(total));
  wrap.setAttribute('aria-valuenow', String(done));
  const track = el('span', 'check-track');
  const fill = el('span', 'check-fill');
  fill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el('span', 'check-count', done + '/' + total));
  return wrap;
}
// kobo-62 — progressive + signal card face (spec #3). Core = title + assignee
// avatar + demoted id + state-accent left-border. Only SIGNAL badges stay on the
// face (epic rollup, checklist bar, PR#, and the blocked-lane reason badges);
// metadata (dept / parent-chip / wait) moves into the detail modal (openDetail).
function taskCard(task, opts) {
  opts = opts || {};
  const card = el('div', 'task st-' + (task.state || 'todo')); // state-accent (left border)
  const head = el('div', 't-head');
  const title = el('div', 't-title', task.title || '(untitled)');
  title.title = task.title || ''; // kobo-127 — collapsed title clamps to 1 line; full text on hover + in modal
  head.appendChild(title);
  head.appendChild(assigneeChip(task.assignee)); // kobo-127 — full-name colored chip, click = filter owner
  card.appendChild(head);
  const meta = el('div', 't-meta');
  // kobo-47: epic rollup badge (▣ N/M) — a SIGNAL (this card contains children) and
  // the on-face filter entry. allDone → green "ลูกครบ รอปิด". Click = filter family.
  const roll = rollupOf(task);
  if (roll) {
    const badge = el('span', 'pill epic-badge' + (roll.allDone ? ' all-done' : ''), '▣ ' + roll.done + '/' + roll.total);
    badge.title = roll.allDone ? 'epic — ลูกครบ รอปิด (' + roll.done + '/' + roll.total + ' children done)' : 'epic rollup — ' + roll.done + '/' + roll.total + ' children done · click to filter family';
    makeChip(badge, () => setFamilyFilter(task.id)); // filter-family stays reachable from the board
    meta.appendChild(badge);
  }
  // kobo-128 — parent-badge: open ask-subcards (questions routed to Tony) on this
  // card. Open → "⧉ N open →tony" (warn); all answered (done) → "⧉ answered ✓" (ok)
  // so the parent's owner knows to come review + close. Click = filter the family.
  const q = questionSubcards(task);
  if (q.length) {
    const open = q.filter((c) => c.state !== 'done');
    const badge = open.length
      ? el('span', 'pill q-open', '⧉ ' + open.length + ' open →tony')
      : el('span', 'pill q-answered', '⧉ answered ✓');
    badge.title = open.length
      ? open.length + ' open question' + (open.length === 1 ? '' : 's') + ' routed to Tony · click to filter family'
      : 'question' + (q.length === 1 ? '' : 's') + ' answered — review + close · click to filter family';
    makeChip(badge, () => setFamilyFilter(task.id));
    meta.appendChild(badge);
  }
  if (task.checklist && task.checklist.total) meta.appendChild(checklistBar(task.checklist.done, task.checklist.total));
  if (task.pr) meta.appendChild(el('span', 'pill pr', 'PR #' + task.pr));
  // blocked-lane reason signals — explain WHY a card is off-flow (only set on such cards).
  if (task.block) meta.appendChild(el('span', 'pill attn', '⚑ ' + task.block.kind + (task.block.for ? ' →' + task.block.for : '') + (task.block.reason ? ': ' + task.block.reason : '')));
  if (task.dependency && task.dependency.blockedBy.length) meta.appendChild(el('span', 'pill attn', '🚫 รอ: ' + task.dependency.blockedBy.join(', ')));
  if (task.dependency && task.dependency.missing.length) meta.appendChild(el('span', 'pill wait', '⚠ parent ไม่พบ: ' + task.dependency.missing.join(', ')));
  if (task.needsOwner) meta.appendChild(el('span', 'pill attn', '⚑ ยังไม่มีเจ้าของ')); // derived needs-owner (kobo-14)
  if (task.stale) meta.appendChild(el('span', 'pill wait', '⏳ stuck? ball on?')); // soft stuck-decision badge (mawjs-5) — visual only
  meta.appendChild(el('span', 't-id', text(task.id))); // id demoted — subtle, pushed right
  card.appendChild(meta);
  // next-action — the board always says what happens next + who (Track 4)
  if (task.nextAction) card.appendChild(el('div', 't-na', '↳ ' + task.nextAction));
  // kobo-127 — note surfacing. Flow-lane cards show ONLY the latest note as a faint
  // one-liner — the trail hides; click the card = expand (full trail in the modal).
  // The Blocked column is Tony's decision queue, so opts.notes==='full' shows every
  // note untruncated for triage-at-a-glance (kobo-199 keeps this when Blocked moved
  // from the floating attention lane into the grid).
  const notes = task.notes || [];
  if (notes.length) {
    if (opts.notes === 'full') {
      const wrap = el('div', 't-notes-full');
      for (const n of notes) {
        const ln = el('div', 't-note');
        ln.appendChild(el('span', 't-note-by', (n.by || '?') + ' · '));
        ln.appendChild(document.createTextNode(n.text || ''));
        wrap.appendChild(ln);
      }
      card.appendChild(wrap);
    } else {
      const n = notes[notes.length - 1];
      const ln = el('div', 't-note-latest');
      ln.appendChild(el('span', 't-note-by', (n.by || '?') + ': '));
      const one = String(n.text || '').replace(/\\s+/g, ' ').trim();
      ln.appendChild(document.createTextNode(one.length > 90 ? one.slice(0, 87) + '…' : one));
      card.appendChild(ln);
    }
  }
  // archive button — ONLY on done cards (kobo-35). done = finished, awaiting
  // human review; clicking archive = Tony signs "checked" → the card moves off
  // the board (store + UI). stopPropagation so it never opens the detail panel.
  if (task.state === 'done' || task.state === 'rejected') {
    const actions = el('div', 't-actions');
    const btn = el('button', 'archive-btn', '📦 archive');
    btn.type = 'button';
    btn.title = 'reviewed — archive off the board';
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); archiveCard(task, btn); });
    actions.appendChild(btn);
    card.appendChild(actions);
  }
  // click → read-only detail panel (eq3-010 kobo-11). Keyboard-reachable too
  // (kobo-42): the card is the control, so give it a role + focus + Enter/Space.
  card.style.cursor = 'pointer';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.addEventListener('click', () => openDetail(task));
  card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(task); } });
  return card;
}

// Archive a reviewed done card (kobo-35). POST /api/tasks/archive → the store
// moves it to tasks/archive/; on success we reload so the board (GET /api/tasks)
// and the store agree — the card is gone from Done on the very next read.
async function archiveCard(task, btn) {
  const company = currentCompany();
  if (!company || !task.id) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '…';
  try {
    // postJson throws on !ok with the server's error message. Guard a (kobo-45):
    // archiving an epic with open children → 409 { error, blockedBy:[ids] }; the
    // thrown message already carries the reason, and we append the child list so
    // the board says exactly which children still block it (kobo-48 guard UX).
    await postJson('/api/tasks/archive', { company: company, id: task.id });
    await load(); // re-read board + timeline; the archived card drops off Done
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prev;
    const kids = (err && err.data && err.data.blockedBy) || [];
    const detail = kids.length ? ' — ลูกที่ยังค้าง: ' + kids.join(', ') : '';
    statusEl.textContent = 'archive blocked: ' + errMsg(err) + detail;
    statusEl.className = 'error';
  }
}

// Read-only card detail — title + meta + body markdown (reuses mdToHtml).
// kobo-56/kobo-71 — deterministic per-author color (hash → index), so each author
// reads as a distinct bubble. kobo-71 swaps to the maw-pane palette (Tony anchor).
// These are BRIGHT pane colors, so the avatar text color is no longer a fixed white:
// avatarText() picks black/white per color luminance (WCAG) so initials stay legible
// on light (yellow/lime/cyan) AND dark (pink/red/purple) avatars. Color stays
// SUPPLEMENTARY — initials + full author name are always shown (color-not-only).
const PANE_COLORS = ['#ff5f87', '#87d787', '#5fd7ff', '#ffd700', '#d787ff', '#ff8700', '#00d7d7', '#ff0000', '#5fff5f', '#af87ff'];
/** Readable text color (#000/#fff) for initials sitting on a pane-color avatar. */
function avatarText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Relative luminance (sRGB, perceptual) → dark text on bright bg, else white.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#111' : '#fff';
}
function authorColor(name) {
  const s = String(name == null ? '?' : name);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PANE_COLORS[h % PANE_COLORS.length];
}
function authorInitials(name) {
  const a = String(name == null ? '?' : name).replace(/[^a-z0-9]/gi, '');
  return (a.slice(0, 2) || '?').toUpperCase();
}
// kobo-116 — render a note body: markdown first (mdToHtml, escape-first), then swap
// maw://<node>/<file>.<ext> image refs for an inline <img>. MVP scope is the local
// node's upload store (/api/files) — the exact endpoint maw_inline_images resolves a
// ref to, and the only place note images land today (mesh upload = kobo-117). The ref
// is matched by a strict [A-Za-z0-9._-] charset + image-ext allowlist (mirror of the
// resolver's MIME_BY_EXT), and we emit the <img> ourselves, so nothing user-authored
// reaches the DOM as HTML. Non-image / non-maw refs are left as mdToHtml produced them.
// ponytail: local node only; cross-node (data-URI via maw_inline_images) is kobo-116 follow-up.
const NOTE_IMG_EXT = /^(png|jpe?g|gif|webp)$/i;
function renderNoteBody(txt) {
  return mdToHtml(txt || '').replace(
    /maw:\\/\\/[A-Za-z0-9._-]+\\/([A-Za-z0-9._-]+\\.([A-Za-z0-9]+))/g,
    function (ref, file, ext) {
      if (!NOTE_IMG_EXT.test(ext)) return ref;
      const url = '/api/files/' + encodeURIComponent(file);
      // anchor → native click-to-open (full-size, new tab); no JS handler needed.
      return '<a class="note-img-link" href="' + url + '" target="_blank" rel="noopener">' +
        '<img class="note-img" loading="lazy" src="' + url + '" alt="' + escapeHtml(file) + '"></a>';
    },
  );
}

// Build one note bubble: avatar (author color + initials) · author name · optional
// ↳source chip (subtask notes) · timestamp; then the note body. el() sets
// textContent → escape-first, XSS-safe. src = source card id for subtask notes.
function noteBubble(n, src) {
  const color = authorColor(n.by);
  const note = el('div', 'note');
  note.style.borderLeftColor = color; // color assignment is a hashed palette index, not user HTML
  const av = el('div', 'note-avatar', authorInitials(n.by));
  av.style.background = color;
  av.style.color = avatarText(color); // kobo-71 — legible initials on bright pane colors
  note.appendChild(av);
  const main = el('div', 'note-main');
  const head = el('div', 'note-head');
  head.appendChild(el('span', 'note-author', n.by || '?'));
  if (src) head.appendChild(el('span', 'note-src', '↳ ' + src));
  head.appendChild(el('span', 'note-ts', n.iso ? (relTime(n.ts) + ' · ' + localTs(n.iso)) : text(n.ts)));
  main.appendChild(head);
  // kobo-115: render the note as markdown (bold/list/code/headings) via mdToHtml —
  // escape-first, so it is XSS-safe like the card body / state.md. Reuses the .md
  // typographic scale so a long note reads as prose, not a flat pre-wrap wall.
  // kobo-116: then swap maw:// image refs for inline <img> (renderNoteBody).
  const body = el('div', 'note-body md');
  body.innerHTML = renderNoteBody(n.text || '');
  main.appendChild(body);
  note.appendChild(main);
  return note;
}

// kobo-190 — approve-lane decision block. Renders ONLY when state === 'approve'
// (the human gate between review and done). merge-case (has pr) = a compact summary
// (merge PR#N → repo · card title · ✓ reviewed by <reviewer>) + a link-out to the PR
// on GitHub — NO fetch/diff render (kobo-190 Q3=a). no-PR case = the card's prose so
// Tony sees what he's approving. The [✅ Approve] button is MARK-ONLY: it posts a
// "✅ Tony approved" comment (reuse /api/tasks/comment, actor=tony server-side) — no
// merge / gh / PR-write. All text via el()/textContent → XSS-safe; the PR href is a
// fixed https://github.com/ prefix + a slug-validated repo (no scheme injection).
function renderDetailApprove(task) {
  const host = $('detail-approve');
  host.replaceChildren();
  if (!task || task.state !== 'approve') { host.hidden = true; return; }
  const box = el('div', 'approve-box');
  box.appendChild(el('div', 'approve-head', '🔎 รอ Tony อนุมัติ'));
  const repo = task.repo || '';
  // owner/name guard for the link href. Split-then-test so the pattern carries no '/'
  // or backslash — a regex escape here would be eaten by the enclosing template literal.
  const repoParts = repo.split('/');
  const slugOk = /^[A-Za-z0-9_.-]+$/;
  const repoOk = repoParts.length === 2 && slugOk.test(repoParts[0]) && slugOk.test(repoParts[1]);
  if (task.pr) {
    const sum = el('div', 'approve-sum');
    sum.appendChild(el('div', 'approve-line', 'merge PR #' + task.pr + (repo ? ' → ' + repo : '')));
    if (task.title) sum.appendChild(el('div', 'approve-title', task.title));
    if (task.reviewer) sum.appendChild(el('div', 'approve-rev', '✓ reviewed by ' + task.reviewer));
    box.appendChild(sum);
    if (repoOk) {
      const a = el('a', 'approve-link', 'เปิด PR ↗');
      a.href = 'https://github.com/' + repo + '/pull/' + task.pr;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
  } else {
    const prose = el('div', 'approve-prose');
    prose.textContent = task.body ? task.body : '(no PR · no detail)';
    box.appendChild(prose);
  }
  const btnRow = el('div', 'approve-actions');
  const btn = el('button', 'approve-btn', '✅ Approve'); btn.type = 'button';
  const msg = el('span', 'approve-msg');
  btn.addEventListener('click', async () => {
    const company = currentCompany();
    if (!company) return;
    btn.disabled = true;
    try {
      await postJson('/api/tasks/comment', { company: company, id: task.id, text: '✅ Tony approved' });
      msg.textContent = 'approved'; msg.className = 'approve-msg ok';
      await load(); reopenDetail(task.id);
    } catch (err) { msg.textContent = 'approve failed: ' + errMsg(err); msg.className = 'approve-msg err'; btn.disabled = false; }
  });
  btnRow.appendChild(btn); btnRow.appendChild(msg);
  box.appendChild(btnRow);
  host.appendChild(box);
  host.hidden = false;
}

// kobo-136 — dependency chips in the drawer: what this card waits on (blockedBy /
// missing, ADR 0003) + the REVERSE edge (cards waiting on this one, derived from
// the cached payload). A resolved chip opens that card's drawer in place.
function renderDetailDeps(task) {
  const bar = $('detail-deps');
  bar.replaceChildren();
  const dep = task.dependency || {};
  for (const id of (dep.blockedBy || [])) {
    const t = taskIndex.byId.get(id);
    const chip = el('span', 'pill attn', '🚫 รอ ' + id);
    chip.title = 'waits on ' + id + (t ? ' · ' + (t.title || '') + ' — click to open' : '');
    if (t) makeChip(chip, () => openDetail(t));
    bar.appendChild(chip);
  }
  for (const id of (dep.missing || [])) {
    const chip = el('span', 'pill wait', '⚠ ' + id + ' ไม่พบ');
    chip.title = 'dependency not on the board (archived or deleted)';
    bar.appendChild(chip);
  }
  for (const t of (lastTasks || [])) {
    if (t.dependency && t.dependency.blockedBy && t.dependency.blockedBy.indexOf(task.id) !== -1) {
      const chip = el('span', 'pill dep-blocks', '⏩ ปลดล็อก ' + t.id);
      chip.title = t.id + ' · ' + (t.title || '') + ' waits on this card — click to open';
      makeChip(chip, () => openDetail(t));
      bar.appendChild(chip);
    }
  }
  bar.hidden = !bar.childNodes.length;
}

// kobo-136 → kobo-143 (v2) — family tree in the drawer: climb containment ancestors
// to the family ROOT, then render the whole RECURSIVE subtree (DFS), the open card
// marked. v2 adds: a breadcrumb path (root → … → current), per-node COLLAPSE of a
// subtree, a 💬 comment count, and a prominent 🎯 owner. Hidden for a loner card (no
// parent, no children). Click a node = open that card in place (same drawer).
function familyRootOf(task) {
  let cur = task;
  const seen = new Set([cur.id]);
  while (cur.epic) {
    const parent = taskIndex.byId.get(cur.epic);
    if (!parent || seen.has(parent.id)) break; // archived/missing parent or cycle → stop here
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}
// Containment path root → … → task (for the breadcrumb). Climbs epic parents,
// cycle/missing-safe, returns oldest-first so the crumb reads left→right.
function familyPathOf(task) {
  const path = [];
  let cur = task;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.epic ? taskIndex.byId.get(cur.epic) : null;
  }
  return path;
}
function renderDetailFamily(task) {
  const host = $('detail-family');
  host.replaceChildren();
  const root = familyRootOf(task);
  const hasKids = (taskIndex.childrenOf.get(task.id) || []).length > 0;
  if (root.id === task.id && !hasKids) { host.hidden = true; return; }
  const box = el('div', 'fam-tree');
  box.appendChild(el('div', 'ft-head', '👪 family · ' + root.id));

  // breadcrumb: root › … › current (each crumb but the current opens that card)
  const path = familyPathOf(task);
  if (path.length > 1) {
    const crumb = el('div', 'ft-crumb');
    path.forEach((t, i) => {
      if (i) crumb.appendChild(el('span', 'ft-crumb-sep', '›'));
      const c = el('span', 'ft-crumb-id' + (t.id === task.id ? ' current' : ''), t.id);
      c.title = t.title || '';
      if (t.id !== task.id) makeChip(c, () => openDetail(t));
      crumb.appendChild(c);
    });
    box.appendChild(crumb);
  }

  // recursive subtree — each node is a branch {row + collapsible children box}
  const addNode = (t, depth) => {
    const branch = el('div', 'ft-branch');
    const kids = taskIndex.childrenOf.get(t.id) || [];
    const row = el('div', 'ft-node' + (t.id === task.id ? ' current' : ''));
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    // collapse toggle (only when there are children) — spacer keeps alignment otherwise
    let childBox = null; let toggle = null;
    if (kids.length) { toggle = el('span', 'ft-toggle', '▾'); toggle.tabIndex = 0; toggle.setAttribute('role', 'button'); toggle.setAttribute('aria-label', 'collapse subtree'); row.appendChild(toggle); }
    else { row.appendChild(el('span', 'ft-toggle ft-toggle-spacer', '')); }
    row.appendChild(el('span', 'ft-dot st-' + (t.state || 'todo')));
    row.appendChild(el('span', 'ft-id', t.id));
    row.appendChild(el('span', 'ft-title', t.title || '(untitled)'));
    // 🎯 owner — prominent assignee chip (per-person color), dim when unassigned
    const owner = el('span', 'ft-owner' + (t.assignee ? '' : ' unassigned'), '🎯 ' + (t.assignee || '—'));
    if (t.assignee) { owner.style.borderColor = authorColor(t.assignee); owner.style.color = authorColor(t.assignee); }
    row.appendChild(owner);
    // 💬 comment count (from c1 comments[]) — unresolved emphasized in the tooltip
    const nCmt = (t.comments || []).length;
    if (nCmt) {
      const nOpen = (t.comments || []).filter((c) => !c.resolved).length;
      const badge = el('span', 'ft-cmt' + (nOpen ? ' has-open' : ''), '💬 ' + nCmt);
      badge.title = nOpen ? (nOpen + ' unresolved of ' + nCmt) : (nCmt + ' resolved');
      row.appendChild(badge);
    }
    row.appendChild(el('span', 'ft-state', t.state || ''));
    row.title = t.id + ' · ' + (t.title || '');
    if (t.id !== task.id) makeChip(row, () => openDetail(t));
    branch.appendChild(row);
    if (kids.length) {
      childBox = el('div', 'ft-children');
      for (const c of kids) childBox.appendChild(addNode(c, depth + 1));
      branch.appendChild(childBox);
      // toggle collapses this subtree. stopPropagation so it doesn't also open the card.
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        childBox.hidden = !childBox.hidden;
        toggle.textContent = childBox.hidden ? '▸' : '▾';
      });
      toggle.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); toggle.click(); } });
    }
    return branch;
  };
  box.appendChild(addNode(root, 0));
  host.appendChild(box);
  host.hidden = false;
}

// kobo-141 — Comments thread: the ask/answer channel (Board Truth rule 10), distinct
// from the notes timeline. Renders task.comments[] threaded by replyTo (roots oldest
// -first, each reply indented under its parent), each unresolved comment carrying a
// reply box + resolve button; a resolved comment dims + shows who/when. All writes go
// through postJson (JSON, no innerHTML) → XSS-safe. author server-side is always "tony".
// kobo-171: indent = clamped level (0 root · 1 · 2 cap); parent = the comment
// this one replies to (null for a root) → drives the uniform reply-target chip.
function commentBubble(task, c, indent, parent) {
  const color = authorColor(c.by);
  const box = el('div', 'cmt' + (indent ? ' reply' : '') + (c.resolved ? ' resolved' : ''));
  box.id = 'cmt-' + c.id; // scroll/highlight target for a child's reply-target chip
  if (indent) box.style.marginLeft = (indent * 26) + 'px'; // 2-level clamp done upstream
  box.style.borderLeftColor = color;
  const av = el('div', 'cmt-avatar', authorInitials(c.by));
  av.style.background = color; av.style.color = avatarText(color);
  box.appendChild(av);
  const main = el('div', 'cmt-main');
  const head = el('div', 'cmt-head');
  head.appendChild(el('span', 'cmt-author', c.by || '?'));
  if (c.resolved) head.appendChild(el('span', 'cmt-resolved-badge', '✓ resolved' + (c.resolvedBy ? ' · ' + c.resolvedBy : '')));
  head.appendChild(el('span', 'cmt-ts', c.iso ? (relTime(c.ts) + ' · ' + localTs(c.iso)) : text(c.ts)));
  main.appendChild(head);
  // Uniform reply-target chip on EVERY reply (any depth) — since indent caps at 2,
  // the chip is what preserves "who is this replying to" past the clamp. All text
  // via el()/textContent → escape-first, no innerHTML (XSS-safe).
  if (parent) {
    const chip = el('button', 'cmt-replytarget'); chip.type = 'button';
    const snip = (parent.text || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    chip.textContent = '↳ ตอบ @' + (parent.by || '?') + (snip ? ' : ' + snip : '');
    chip.title = 'ไปที่ความเห็นที่ตอบ';
    chip.addEventListener('click', () => {
      const tgt = $('cmt-' + parent.id);
      if (!tgt) return;
      tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      tgt.classList.add('cmt-flash');
      setTimeout(() => tgt.classList.remove('cmt-flash'), 1500);
    });
    main.appendChild(chip);
  }
  const body = el('div', 'cmt-body md');
  body.innerHTML = renderNoteBody(c.text || ''); // same escape-first markdown+image path as notes
  main.appendChild(body);
  // reply + resolve actions (unresolved only — a resolved thread is closed)
  if (!c.resolved) {
    const actions = el('div', 'cmt-actions');
    const replyBtn = el('button', 'cmt-act', '↩ reply'); replyBtn.type = 'button';
    const resolveBtn = el('button', 'cmt-act', '✓ resolve'); resolveBtn.type = 'button';
    actions.appendChild(replyBtn); actions.appendChild(resolveBtn);
    main.appendChild(actions);
    replyBtn.addEventListener('click', () => {
      if (main.querySelector('.cmt-reply-box')) return; // one open reply box at a time
      const rb = el('div', 'cmt-reply-box');
      const rin = el('input'); rin.type = 'text'; rin.placeholder = 'reply…'; rin.maxLength = 2000;
      const rsend = el('button', '', 'send'); rsend.type = 'button';
      rb.appendChild(rin); rb.appendChild(rsend);
      main.appendChild(rb); rin.focus();
      const doReply = async () => {
        const company = currentCompany(); const val = rin.value.trim();
        if (!company || !val) return;
        rsend.disabled = true;
        try { await postJson('/api/tasks/comment', { company: company, id: task.id, text: val, replyTo: c.id }); await load(); reopenDetail(task.id); }
        catch (err) { rsend.disabled = false; statusEl.textContent = 'reply failed: ' + errMsg(err); statusEl.className = 'error'; }
      };
      rsend.addEventListener('click', doReply);
      rin.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doReply(); } });
    });
    resolveBtn.addEventListener('click', async () => {
      const company = currentCompany();
      if (!company) return;
      resolveBtn.disabled = true;
      try { await postJson('/api/tasks/resolve', { company: company, id: task.id, commentId: c.id }); await load(); reopenDetail(task.id); }
      catch (err) { resolveBtn.disabled = false; statusEl.textContent = 'resolve failed: ' + errMsg(err); statusEl.className = 'error'; }
    });
  }
  box.appendChild(main);
  return box;
}

// kobo-171: pure tree walker injected from the module fn (single source, unit-tested).
${stateBadge.toString()}
${orderCommentTree.toString()}
${foldableResolvedIds.toString()}
${newestVisibleCommentId.toString()}
${parseCardId.toString()}
const COLLAPSIBLE_COLS = ${JSON.stringify(COLLAPSIBLE_COLS)}; // kobo-194 — injected literal (columnCollapsed reads it)
${columnCollapsed.toString()}

function renderDetailComments(task) {
  const host = $('detail-comments');
  host.replaceChildren();
  host.classList.remove('show-resolved'); // fresh open = resolved folded
  const comments = task.comments || [];
  if (!comments.length) return;
  host.appendChild(el('div', 'comments-head', 'comments (' + comments.length + ')'));
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  const foldable = foldableResolvedIds(comments); // resolved comments whose whole subtree is resolved (kobo-176)
  // toggle folds ONLY fully-resolved branches — unresolved (and resolved ancestors
  // of unresolved) always show, so threading/indent/chip (kobo-171) is untouched.
  if (foldable.size) {
    const label = (shown) => (shown ? '▾' : '▸') + ' ' + foldable.size + ' resolved · ' + (shown ? 'hide' : 'show');
    const toggle = el('button', 'cmt-resolved-toggle', label(false)); toggle.type = 'button';
    toggle.addEventListener('click', () => { toggle.textContent = label(host.classList.toggle('show-resolved')); });
    host.appendChild(toggle);
  }
  // recurse the FULL tree (depth-3+ no longer dropped); indent clamped to 2 levels.
  for (const node of orderCommentTree(comments)) {
    const parent = node.c.replyTo ? byId.get(node.c.replyTo) : null;
    const bubble = commentBubble(task, node.c, node.indent, parent);
    if (foldable.has(node.c.id)) bubble.classList.add('cmt-foldable'); // CSS hides unless .show-resolved
    host.appendChild(bubble);
  }
}

function openDetail(task) {
  if (task && task.id) syncUrlToCard(task.id); // kobo-181: reflect the open card in the URL (deep-link)
  $('detail-title').textContent = (task.id ? task.id + ' · ' : '') + (task.title || '(untitled)');
  renderDetailMeta(task); // kobo-62: dept / parent-chip / wait moved off the card face → here
  renderDetailApprove(task); // kobo-190: approve-only summary + link-out + mark-only Approve button
  renderDetailDeps(task);   // kobo-136: dependency chips (waits-on / missing / unblocks)
  renderDetailFamily(task); // kobo-136: family tree (root → descendants, current marked)
  const bodyEl = $('detail-body');
  if (task.body) { bodyEl.replaceChildren(renderCardBody(task.body)); } // kobo-60: structured field/scope blocks + prose
  else { const p = el('p', '', '(no detail — add one with: maw company task add ... --body)'); p.style.color = 'var(--muted)'; bodyEl.replaceChildren(p); }
  // kobo-141: the ask/answer comment thread (Board Truth rule 10) sits above the
  // notes log — comments are the primary channel now, notes are evidence/log.
  renderDetailComments(task);
  // kobo-39: append-only notes timeline (who / when / what) below the body. Reuse
  // the worklog .entry/.e-* classes. el() sets textContent → escape-first, XSS-safe.
  // kobo-141: notes are now COLLAPSIBLE (หุบได้) + collapsed by default, so the
  // comment thread leads and the evidence log stays a click away.
  const notesEl = $('detail-notes');
  notesEl.replaceChildren();
  const notes = task.notes || [];
  const childNotes = childNotesOf(task); // kobo-47: an epic also gathers descendant notes, tagged by source
  const totalNotes = notes.length + childNotes.length;
  if (totalNotes) {
    const toggle = el('button', 'notes-head notes-toggle', '▸ notes (' + totalNotes + ')'); toggle.type = 'button';
    const notesBody = el('div', 'notes-body'); notesBody.hidden = true;
    for (const n of notes) notesBody.appendChild(noteBubble(n)); // oldest-first = a timeline
    if (childNotes.length) {
      notesBody.appendChild(el('div', 'notes-head', 'notes from subtasks (' + childNotes.length + ')'));
      for (const n of childNotes) notesBody.appendChild(noteBubble(n, n.from)); // own vs sub kept separate — source never ambiguous
    }
    toggle.addEventListener('click', () => {
      notesBody.hidden = !notesBody.hidden;
      toggle.textContent = (notesBody.hidden ? '▸' : '▾') + ' notes (' + totalNotes + ')';
      if (!notesBody.hidden) clampLongNotes(); // measure only once shown (hidden → scrollHeight 0)
    });
    notesEl.appendChild(toggle); notesEl.appendChild(notesBody);
  }
  // kobo-48: write controls (+ subtask, comment box) live inside the modal.
  buildWriteSection(task);
  openModal();
  scrollToNewestComment(task); // kobo-180: land on the newest comment (after openModal — hidden = no layout)
}

// kobo-180: on open, bring the newest VISIBLE comment into view so a busy card lands
// on the latest activity instead of the oldest. Order is untouched (kobo-171 DFS +
// kobo-176 collapse) — this only scrolls. Must run after openModal(): a hidden
// container has no layout, so scrollIntoView would be a no-op (clampLongNotes lesson,
// kobo-115). block:'nearest' scrolls the #detail-comments overflow container, not the
// whole modal. Newest may be folded/hidden → target the newest VISIBLE one (never a
// display:none element); all folded → nothing to do.
function scrollToNewestComment(task) {
  const comments = task.comments || [];
  if (!comments.length) return;
  const id = newestVisibleCommentId(comments, foldableResolvedIds(comments));
  if (!id) return; // every comment folded → no visible target
  const target = document.getElementById('cmt-' + id);
  if (target) target.scrollIntoView({ block: 'nearest' });
}

// kobo-115: a long note clamps to a few lines with a show-more toggle so one tall
// note can't push the rest of the timeline out of view. Must run after openModal()
// — a hidden element reports scrollHeight 0, so nothing would ever clamp.
function clampLongNotes() {
  const CAP = 150; // px — matches .note-body.clamp max-height
  for (const body of $('detail-notes').querySelectorAll('.note-body')) {
    if (body.scrollHeight <= CAP + 24) continue; // small slack → not worth a toggle
    body.classList.add('clamp');
    const btn = el('button', 'note-more', 'show more');
    btn.addEventListener('click', function () {
      const clamped = body.classList.toggle('clamp');
      btn.textContent = clamped ? 'show more' : 'show less';
    });
    body.after(btn);
  }
}

// kobo-48 web write — the modal's write controls: a "+ subtask" input (creates a
// child card, epic = this card) and a comment box (POST /api/tasks/note, notifies
// the assignee via c2). Rebuilt on every openDetail so it always targets the
// currently-open card. All values go out as JSON (no innerHTML) → XSS-safe.
function buildWriteSection(task) {
  const wrap = $('detail-write');
  wrap.replaceChildren();
  const msg = el('div', 'write-msg');
  const setMsg = (t, ok) => { msg.textContent = t; msg.className = 'write-msg ' + (ok ? 'ok' : 'err'); };

  // + subtask
  const subRow = el('div', 'write-row');
  subRow.appendChild(el('label', '', '+ subtask (child of ' + task.id + ')'));
  const subLine = el('div', 'row');
  const subInput = el('input'); subInput.type = 'text'; subInput.placeholder = 'short subtask title…'; subInput.maxLength = 200;
  const subBtn = el('button', '', '+ add'); subBtn.type = 'button';
  subLine.appendChild(subInput); subLine.appendChild(subBtn);
  subRow.appendChild(subLine);

  // comment (kobo-141) — starts an ask/answer thread (POST /api/tasks/comment). An
  // @mention stays in the mentions queue until resolved. Distinct from a note (log).
  const cmtRow = el('div', 'write-row');
  cmtRow.appendChild(el('label', '', 'comment · ask/answer (@mention → queue until resolved · notifies assignee)'));
  const cmtLine = el('div', 'row');
  const cmtInput = el('textarea'); cmtInput.placeholder = 'comment… @mention to ask (⌘/Ctrl+Enter to send)';
  const cmtBtn = el('button', '', 'comment'); cmtBtn.type = 'button';
  cmtLine.appendChild(cmtInput); cmtLine.appendChild(cmtBtn);
  cmtRow.appendChild(cmtLine);

  // note (kobo-141) — append-only log/evidence (POST /api/tasks/note). No questions
  // here (Board Truth rule 10); an @ in a note does NOT enter the mentions queue.
  const noteRow = el('div', 'write-row');
  noteRow.appendChild(el('label', '', 'note · log/evidence (append-only)'));
  const noteLine = el('div', 'row');
  const noteInput = el('textarea'); noteInput.placeholder = 'note… (⌘/Ctrl+Enter to send)';
  const noteBtn = el('button', '', 'add note'); noteBtn.type = 'button';
  noteLine.appendChild(noteInput); noteLine.appendChild(noteBtn);
  noteRow.appendChild(noteLine);

  // mark done (kobo-50, item 1) — only on a card not already done. Gives c1 guard b
  // its web trigger: an epic whose children aren't all done → server 409 needsConfirm
  // + rollup, and we ask before forcing the close (scope collapse).
  if (task.state !== 'done' && task.state !== 'rejected') {
    const doneRow = el('div', 'write-row');
    const doneBtn = el('button', 'done-btn', '✓ mark done'); doneBtn.type = 'button';
    doneRow.appendChild(doneBtn);
    wrap.appendChild(doneRow);
    async function postDone(confirm) {
      await postJson('/api/tasks/done', { company: currentCompany(), id: task.id, confirm: confirm });
      setMsg('marked done', true);
      await load(); closeDetail(); // card is done → shows in the Done column
    }
    // Inline (non-blocking) confirm — a native confirm() blocks the page thread and
    // is unreachable to assistive tech / e2e drivers. Guard b: server 409s with the
    // rollup, we render "children N/M — confirm?" with yes/no in the message area.
    function askConfirm(r) {
      msg.className = 'write-msg';
      msg.replaceChildren();
      msg.appendChild(el('span', '', 'epic ' + task.id + ' ลูกเสร็จ ' + (r.done || 0) + '/' + (r.total != null ? r.total : '?') + ' — mark done? (scope ยุบได้) '));
      const yes = el('button', 'done-btn confirm-yes', 'confirm done'); yes.type = 'button';
      const no = el('button', '', 'cancel'); no.type = 'button'; no.style.marginLeft = '6px';
      msg.appendChild(yes); msg.appendChild(no);
      no.addEventListener('click', () => setMsg('ยกเลิก', false));
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try { await postDone(true); } catch (e2) { setMsg('mark done failed: ' + errMsg(e2), false); }
      });
    }
    async function submitDone() {
      if (!currentCompany()) return;
      doneBtn.disabled = true;
      try {
        await postDone(false);
      } catch (err) {
        if (err && err.status === 409 && err.data && err.data.needsConfirm) askConfirm(err.data.rollup || {});
        else setMsg('mark done failed: ' + errMsg(err), false);
      } finally { doneBtn.disabled = false; }
    }
    doneBtn.addEventListener('click', submitDone);
  }

  wrap.appendChild(subRow); wrap.appendChild(cmtRow); wrap.appendChild(noteRow); wrap.appendChild(msg);

  async function submitSub() {
    const company = currentCompany();
    const title = subInput.value.trim();
    if (!company || !title) { setMsg('enter a subtask title', false); return; }
    subBtn.disabled = true;
    try {
      const res = await postJson('/api/tasks/create', { company: company, title: title, epic: task.id });
      subInput.value = '';
      setMsg('created ' + ((res.task && res.task.id) || 'subtask'), true);
      await load();          // board picks up the new child + this card's rollup badge
      reopenDetail(task.id); // refresh the modal in place
    } catch (err) { setMsg('create failed: ' + errMsg(err), false); }
    finally { subBtn.disabled = false; }
  }
  async function submitCmt() {
    const company = currentCompany();
    const t = cmtInput.value.trim();
    if (!company || !t) { setMsg('enter a comment', false); return; }
    cmtBtn.disabled = true;
    try {
      await postJson('/api/tasks/comment', { company: company, id: task.id, text: t });
      cmtInput.value = '';
      setMsg('comment added', true);
      await load();
      reopenDetail(task.id); // refresh the comment thread
    } catch (err) { setMsg('comment failed: ' + errMsg(err), false); }
    finally { cmtBtn.disabled = false; }
  }
  async function submitNote() {
    const company = currentCompany();
    const t = noteInput.value.trim();
    if (!company || !t) { setMsg('enter a note', false); return; }
    noteBtn.disabled = true;
    try {
      await postJson('/api/tasks/note', { company: company, id: task.id, text: t });
      noteInput.value = '';
      setMsg('note added', true);
      await load();
      reopenDetail(task.id); // refresh the notes timeline
    } catch (err) { setMsg('note failed: ' + errMsg(err), false); }
    finally { noteBtn.disabled = false; }
  }
  subBtn.addEventListener('click', submitSub);
  subInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitSub(); } });
  cmtBtn.addEventListener('click', submitCmt);
  cmtInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitCmt(); } });
  noteBtn.addEventListener('click', submitNote);
  noteInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitNote(); } });
}

// Re-open the modal for a card id from the freshest payload (after a write +
// load()), so rollup/notes reflect the change. No-op if the card vanished.
function reopenDetail(id) {
  const t = (lastTasks || []).find((x) => x.id === id);
  if (t) openDetail(t);
}

function errMsg(err) { return (err && err.message) ? err.message : String(err); }

// POST JSON → parsed body. Throws on !ok with the server's { error } message
// (and stashes .status/.data) so callers surface a real reason, not just a code.
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || (url + ' → ' + res.status));
    e.status = res.status; e.data = data;
    throw e;
  }
  return data || { ok: true };
}

// kobo-44: card detail is a modal overlay. Open = show backdrop, remember the
// trigger to restore focus, move focus into the dialog. Close = hide + restore.
let detailReturnFocus = null;
function openModal() {
  // Only capture the return-focus trigger on a FRESH open — reopening in place
  // (kobo-48: after a write, to refresh the modal) must not clobber it with the
  // panel itself, or Esc/close would restore focus to nowhere useful.
  if ($('detail-overlay').hidden) detailReturnFocus = document.activeElement;
  $('detail-overlay').hidden = false;
  $('detail-panel').focus();
}
function closeDetail() {
  dropCardFromUrl(); // kobo-181: leaving the card → drop ?card in place (popstate close = already dropped, no-op)
  $('detail-overlay').hidden = true;
  if (detailReturnFocus && detailReturnFocus.focus) detailReturnFocus.focus();
  detailReturnFocus = null;
}

// ── kobo-128 — @mentions queue + ask-subcard (question) helpers ───────────────
// Client-side mirrors of store.mentionKey / parseMentions / pendingMentions so the
// board's mentions queue matches "maw task mentions" (UI↔CLI parity, Board Truth 7).
// @tony and @human collapse to one canonical key (head Q3).
const HUMAN_ALIASES = { tony: 1, human: 1 };
function mentionKey(name) { const n = String(name == null ? '' : name).trim().toLowerCase().replace(/^@/, ''); return HUMAN_ALIASES[n] ? 'tony' : n; }
function parseMentions(t) { const out = new Set(); const re = /@([a-z0-9_-]+)/gi; let m; while ((m = re.exec(String(t || '')))) out.add(mentionKey(m[1])); return Array.from(out); }
// Unanswered @mentions across on-board cards (kobo-140 repoint): the ask/answer
// channel moved from notes to COMMENTS (Board Truth rule 10), so a mention is
// pending until its comment is RESOLVED (explicit), not "someone noted after".
// Mirrors store.pendingMentions — an unresolved comment carrying an @mention.
function pendingMentions(tasks) {
  const out = [];
  for (const t of tasks) {
    for (const c of (t.comments || [])) {
      if (c.resolved) continue; // resolved thread → out of the queue
      for (const who of parseMentions(c.text)) out.push({ id: t.id, title: t.title, who: who, by: c.by, ts: c.ts, text: c.text, commentId: c.id });
    }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}
// ask-subcards (questions routed to a person) = DIRECT children carrying an
// assignee in the tony queue. +subtask children are created unassigned, so a
// tony-assigned child is an ask output — the signal the parent-badge reads.
function questionSubcards(task) {
  const kids = taskIndex.childrenOf.get(task.id) || [];
  return kids.filter((c) => c.assignee && mentionKey(c.assignee) === 'tony');
}

// kobo-128 → kobo-141 — the @mention decision queue at the board head: pending
// @tony/@human mentions (unresolved comments now), each with a quick reply (POST
// /api/tasks/comment, reply-to the mention's comment) + a resolve button (POST
// /api/tasks/resolve → clears it from the queue). actor=tony.
function renderMentions(tasks) {
  const bar = $('mentions-bar');
  const pend = pendingMentions(tasks).filter((m) => m.who === 'tony'); // Tony's board = his decision queue
  if (!pend.length) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.replaceChildren();
  const head = el('div', 'mentions-head');
  head.appendChild(el('span', '', '@ mentions · รอ Tony reply'));
  head.appendChild(el('span', 'count', String(pend.length)));
  bar.appendChild(head);
  for (const m of pend) {
    const row = el('div', 'mention-row');
    const idc = el('span', 'mention-id', m.id);
    makeChip(idc, () => { const t = taskIndex.byId.get(m.id); if (t) openDetail(t); }); // click id → open the card
    row.appendChild(idc);
    row.appendChild(el('span', 'mention-who', 'by ' + (m.by || '?')));
    const one = String(m.text || '').replace(/\\s+/g, ' ').trim();
    const txt = el('span', 'mention-txt', one); txt.title = m.text || '';
    row.appendChild(txt);
    const rin = el('input'); rin.type = 'text'; rin.className = 'mention-reply-in'; rin.placeholder = 'reply…';
    const rbtn = el('button', 'mention-reply-btn', 'reply'); rbtn.type = 'button';
    const resbtn = el('button', 'mention-reply-btn', '✓ resolve'); resbtn.type = 'button';
    const send = async () => {
      const val = rin.value.trim();
      if (!currentCompany() || !val) return;
      rbtn.disabled = true;
      // reply-to the mention's comment → threads the answer; the thread stays in the
      // queue until resolved (explicit). Use ✓ resolve to clear it.
      try { await postJson('/api/tasks/comment', { company: currentCompany(), id: m.id, text: val, replyTo: m.commentId }); rin.value = ''; await load(); }
      catch (err) { rbtn.disabled = false; statusEl.textContent = 'reply failed: ' + errMsg(err); statusEl.className = 'error'; }
    };
    const resolve = async () => {
      if (!currentCompany()) return;
      resbtn.disabled = true;
      try { await postJson('/api/tasks/resolve', { company: currentCompany(), id: m.id, commentId: m.commentId }); await load(); }
      catch (err) { resbtn.disabled = false; statusEl.textContent = 'resolve failed: ' + errMsg(err); statusEl.className = 'error'; }
    };
    rbtn.addEventListener('click', send);
    resbtn.addEventListener('click', resolve);
    rin.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
    row.appendChild(rin); row.appendChild(rbtn); row.appendChild(resbtn);
    bar.appendChild(row);
  }
  bar.hidden = false;
}

const FLOW = ['backlog', 'todo', 'ready', 'in-progress', 'review', 'approve', 'done'];
const COLS = ['backlog', 'todo', 'ready', 'in-progress', 'review', 'approve', 'blocked', 'done', 'rejected']; // board columns = flow + Blocked (kobo-199, off-flow) + Rejected terminal lane (kobo-101)
// kobo-199 — lanes that VANISH from the grid when they hold 0 cards. Parking
// (backlog/rejected) never join — they use the 194/197 reveal control. Blocked is
// deliberately EXEMPT (always-on) so it never "disappears" — honoring Tony's original
// "blocked หายไปไหน" complaint; a card lands there for a decision, so its column stays
// visible even at 0. To make Blocked hide-when-empty like the rest, add 'blocked' here.
const HIDE_WHEN_EMPTY = ['todo', 'ready', 'in-progress', 'review', 'approve', 'done'];

// kobo-127 — Done lane fold: newest 5 (by updatedTs) + a "show all N"/"collapse"
// toggle, so 40 finished cards never bury the live lanes. Sort is a display-only
// copy; the payload order is untouched.
function renderDoneLane(col, cards) {
  if (!cards.length) return;
  const sorted = cards.slice().sort((a, b) => (b.updatedTs || b.ts || 0) - (a.updatedTs || a.ts || 0));
  const LIMIT = 5;
  const visible = doneExpanded ? sorted : sorted.slice(0, LIMIT);
  for (const t of visible) col.appendChild(taskCard(t));
  if (sorted.length > LIMIT) {
    const btn = el('button', 'done-fold', doneExpanded ? '▲ collapse' : ('▾ show all ' + sorted.length));
    btn.type = 'button';
    btn.addEventListener('click', () => { doneExpanded = !doneExpanded; renderBoard(lastTasks); });
    col.appendChild(btn);
  }
}

// kobo-194: persisted collapse state — a {col:boolean} map in localStorage. Absent
// key = default (collapsed). Never throws (private mode → in-memory only).
function loadCollapseState() {
  try { return JSON.parse(localStorage.getItem('maw-company-collapsed') || '{}') || {}; }
  catch (e) { return {}; }
}
function saveCollapseState(state) {
  try { localStorage.setItem('maw-company-collapsed', JSON.stringify(state)); } catch (e) { /* private mode — session-only */ }
}
// Apply the collapse state to the collapsible columns: toggle the .collapsed
// class on the .col element (CSS hides its cards) + flip the chevron glyph. Pure
// DOM sync from state — safe to call on every render.
function applyColumnCollapse() {
  const state = loadCollapseState();
  for (const col of COLLAPSIBLE_COLS) {
    const colEl = document.querySelector('.col-' + col);
    if (!colEl) continue; // column not on the board (defensive)
    const collapsed = columnCollapsed(col, state);
    colEl.classList.toggle('collapsed', collapsed);
    const chev = colEl.querySelector('.col-chevron');
    if (chev) { chev.textContent = collapsed ? '▸' : '▾'; chev.setAttribute('aria-expanded', String(!collapsed)); }
  }
  // kobo-197 — reflow the grid to the visible column count so the active lanes take
  // full width when parking columns are hidden (a display:none column frees its track;
  // a static repeat(8) would leave an empty gap instead).
  const board = document.querySelector('.board');
  if (board) {
    const visible = Array.prototype.filter.call(board.querySelectorAll('.col'), (c) => !c.classList.contains('collapsed') && !c.classList.contains('lane-empty')).length;
    board.style.gridTemplateColumns = 'repeat(' + Math.max(visible, 1) + ', minmax(150px, 1fr))';
  }
  // kobo-197 — reveal button reflects the hidden parking columns (chevrons are
  // unreachable once a column is display:none, so this is the way back).
  const btn = document.getElementById('reveal-parking');
  if (btn) {
    const hidden = COLLAPSIBLE_COLS.filter((col) => columnCollapsed(col, state));
    btn.textContent = hidden.length ? '⊕ แสดง parking (' + hidden.length + ')' : '⊖ ซ่อน parking';
    btn.setAttribute('aria-expanded', String(hidden.length === 0));
  }
}
// One-time wire: a chevron click flips that column's state + persists + re-applies.
// kobo-197 — the reveal button bulk-toggles ALL parking columns (any hidden → reveal
// all; none hidden → hide all), the single entry point when they're display:none.
function wireColumnCollapse() {
  for (const chev of document.querySelectorAll('.col-chevron')) {
    chev.addEventListener('click', () => {
      const col = chev.dataset.col;
      const state = loadCollapseState();
      state[col] = !columnCollapsed(col, state); // toggle from the effective (default-aware) value
      saveCollapseState(state);
      applyColumnCollapse();
    });
  }
  const reveal = document.getElementById('reveal-parking');
  if (reveal) {
    reveal.addEventListener('click', () => {
      const state = loadCollapseState();
      const anyHidden = COLLAPSIBLE_COLS.some((col) => columnCollapsed(col, state));
      for (const col of COLLAPSIBLE_COLS) state[col] = !anyHidden; // reveal all, else hide all
      saveCollapseState(state);
      applyColumnCollapse();
    });
  }
}

function renderBoard(tasks) {
  // Family/assignee filters are display-only — taskIndex stays built over the FULL
  // list so rollup / parent-chip / family membership still resolve against every card.
  updateFamilyBar();
  updateAssigneeBar(); // kobo-127 — owner filter clear bar
  renderMentions(tasks); // kobo-128 — @mention decision queue at the board head
  const fam = familyFilter ? familyMembers(familyFilter) : null;
  let shown = fam ? tasks.filter((t) => fam.has(t.id)) : tasks;
  if (assigneeFilter) shown = shown.filter((t) => t.assignee === assigneeFilter); // kobo-127 — owner filter
  const cols = {};
  // COLS = the linear flow + the parallel terminal Rejected lane (kobo-101). Both
  // are real board columns; the Blocked lane is separate (off-flow, below).
  for (const s of COLS) { cols[s] = $(s); cols[s].replaceChildren(); }
  const attn = $('blocked'); attn.replaceChildren();
  const counts = { backlog: 0, todo: 0, ready: 0, 'in-progress': 0, review: 0, approve: 0, done: 0, rejected: 0, blocked: 0 };
  // Off-flow = explicit block (state) OR derived dependency block (ADR 0003) —
  // ONE Blocked lane, mirroring the CLI board. Derived cards keep their real
  // flow state but are pulled out while a parent is pending; when the parent is
  // done the next poll drops the dependency field and the card returns.
  const isOffFlow = (task) => task.state === 'blocked' || (task.dependency && task.dependency.blockedBy.length > 0) || task.needsOwner;
  const doneCards = []; // kobo-127 — deferred so the Done lane can fold to newest 5
  for (const task of shown) {
    // kobo-199 — Blocked moved from the floating attention lane (kobo-55) into the
    // grid as col-blocked, but stays Tony's decision queue → keep the full-notes face
    // for triage-at-a-glance (block-reason badge also rides in the card meta).
    if (isOffFlow(task)) { attn.appendChild(taskCard(task, { notes: 'full' })); counts['blocked']++; continue; }
    const state = cols[task.state] ? task.state : 'todo';
    if (state === 'done') { doneCards.push(task); counts['done']++; continue; }
    cols[state].appendChild(taskCard(task));
    counts[state]++;
  }
  renderDoneLane(cols['done'], doneCards); // kobo-127 — newest 5 + "show all N"
  for (const s of COLS) {
    $('c-' + s).textContent = counts[s];
    const colEl = document.querySelector('.col-' + s);
    if (HIDE_WHEN_EMPTY.includes(s)) {
      // kobo-199 — a hide-when-empty lane vanishes at 0 cards and reappears once one lands.
      if (colEl) colEl.classList.toggle('lane-empty', counts[s] === 0);
    } else if (counts[s] === 0) {
      // parking (194/197 reveal control) or an always-on lane → keep the column, show "—".
      cols[s].appendChild(el('div', 'empty', '—'));
    }
  }
  applyColumnCollapse(); // kobo-194/197 — re-fold parking + reflow the grid to the visible column count
}

// Worklog ts is stored UTC (ISO). This renders in the browser, so format in the
// VIEWER's local timezone (Tony = Asia/Bangkok = GMT+7) — same compact
// YYYY-MM-DD HH:MM:SS shape, just shifted off raw UTC. Falls back to the raw
// string if the ISO won't parse.
function localTs(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function renderTimeline(entries) {
  // kobo-109 — 'idle' events (CC Stop) are a per-pane state signal for the Presence tab,
  // not timeline activity. Drop them here so the Worklog feed stays real work only.
  entries = (entries || []).filter(e => e.kind !== 'idle');
  const tl = $('timeline');
  tl.replaceChildren();
  if (!entries.length) { tl.appendChild(el('div', 'empty', 'no worklog entries')); return; }
  for (const e of entries.slice().reverse()) {
    const row = el('div', 'entry');
    // kobo-63: author's pane color (hash) on avatar + left accent — supplementary,
    // the oracle name below is always shown (color-not-only). Same helpers as notes.
    const color = authorColor(e.oracle);
    row.style.borderLeftColor = color;
    const av = el('div', 'e-avatar', authorInitials(e.oracle));
    av.style.background = color; av.style.color = avatarText(color);
    row.appendChild(av);
    const main = el('div', 'e-main');
    const head = el('div', 'e-head');
    head.appendChild(el('span', 'e-oracle', e.oracle || '?'));
    head.appendChild(el('span', 'e-kind', e.kind || ''));
    // "5m ago · 2026-07-03 17:12:03" — relative for scan speed, absolute for record.
    const ts = e.iso ? (relTime(e.ts) + ' · ' + localTs(e.iso)) : text(e.ts);
    head.appendChild(el('span', 'e-ts', ts));
    main.appendChild(head);
    main.appendChild(el('div', 'e-summary', e.summary || ''));
    row.appendChild(main);
    tl.appendChild(row);
  }
}

// kobo-49 c5 — compact "5m ago" relative time from an epoch ms; falls back to '' .
function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((nowMs() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
// Wall clock read once per render (Date.now is fine in the browser).
function nowMs() { return Date.now(); }

// kobo-50 — Presence = the AUTHORITATIVE company roster (GET /api/roster, from the
// company registry) overlaid with worklog-derived activity. Every registered oracle
// appears even with zero recent activity (the c5 gap: clock-in/out/seat/toilet are
// free-text, not distinct worklog kinds, so activity alone under-counts membership).
// Live status (last-seen · pane · count · last action) is still derived from the
// worklog feed; a best-effort scan surfaces clock-in/out/seat/toilet lines when present.
const STATUS_RE = /(clock[ -]?in|clock[ -]?out|clocked in|clocked out|\\/toilet|\\btoilet\\b|\\/seat|\\bseat\\b|\\bflush\\b|clock-out)/i;
const ACTIVE_MS = 10 * 60 * 1000; // green dot = active within 10 min

// Context % remaining for a presence pane: prefer remaining_percentage, fall back
// to 100-used_percentage. null (pre-first-API-call / post-compact) → the UI
// renders "—". A STALE pane still shows its last-known % (kobo-108) — the file
// data isn't gone, the statusline just stopped re-rendering while idle; the row's
// is-stale dimming already signals "last known", so blanking it hid live info.
function ctxPct(p) {
  if (!p) return null;
  if (typeof p.remaining_percentage === 'number') return Math.round(p.remaining_percentage);
  if (typeof p.used_percentage === 'number') return Math.round(100 - p.used_percentage);
  return null;
}
function renderPresence(entries, roster, presence, held) {
  entries = entries || []; roster = roster || []; presence = presence || []; held = held || {};
  // kobo-104 — per-pane model + context% overlay. Group the host-wide presence
  // rows by oracle so each roster card can list its live pane(s): an oracle with
  // one pane shows one sub-row, a crew/warroom oracle shows N (KEY = pane).
  const panesByOracle = new Map();
  for (const p of presence) {
    if (!p || !p.oracle) continue; // a pane with no self-described oracle can't be matched to the roster
    let arr = panesByOracle.get(p.oracle);
    if (!arr) { arr = []; panesByOracle.set(p.oracle, arr); }
    arr.push(p);
  }
  for (const arr of panesByOracle.values()) arr.sort((a, b) => (a.pane || '').localeCompare(b.pane || ''));
  const host = $('presence');
  host.replaceChildren();
  const note = el('div', 'presence-note');
  note.innerHTML = 'Company roster from <b>/api/roster</b> (authoritative membership) — every registered oracle appears, even with no recent activity. Live status (last-seen · pane · count · last action) is derived from the worklog feed; clock-in/out/seat/toilet are best-effort text matches, not structured events.';
  host.appendChild(note);
  // Fold the feed to one activity record per oracle: newest entry wins for last-seen + pane.
  // kobo-109 — ALSO derive a durable busy/idle state PER PANE, keyed by paneId (%N, the
  // stable TMUX_PANE join key — NOT the display pane index). The newest event for a pane
  // decides: an 'idle' event (CC Stop hook, persisted to worklog.jsonl) → idle, any other
  // activity → busy. Reading it from the persisted feed (not volatile recency) is what makes
  // the badge survive a maw-server restart (decision B). paneId matches the presence file's
  // pane (%N) so the two join per-pane. 'idle' events are kept OUT of the oracle-level fold
  // (count/last/active) — they are a pane-state signal, not real activity.
  const byOracle = new Map();
  // paneId (%N) → { ts, state } from the newest event touching the pane. state is the
  // 3-state work-state (kobo-111): 'error' (turn ended on an API error) / 'idle' (turn
  // ended) / 'busy' (any activity). newest-wins, so the next prompt (busy) auto-clears
  // an error or idle. Both 'idle' and 'error' are turn-ending states kept OUT of the
  // oracle activity fold below — 'error' still rides the feed/inject (rare + actionable).
  const paneState = new Map();
  const oraclesWithError = new Set(); // any oracle whose newest per-pane state is 'error'
  for (const e of entries) {
    if (e.paneId) {
      const cur = paneState.get(e.paneId);
      if (!cur || (e.ts || 0) >= cur.ts) {
        const state = e.kind === 'error' ? 'error' : (e.kind === 'idle' ? 'idle' : (e.kind === 'away' ? 'away' : 'busy'));
        paneState.set(e.paneId, { ts: e.ts || 0, state, oracle: e.oracle || '?' });
      }
    }
    if (e.kind === 'idle' || e.kind === 'error' || e.kind === 'away') continue; // pane-state signals — not an oracle activity record
    const key = e.oracle || '?';
    let o = byOracle.get(key);
    if (!o) { o = { oracle: key, pane: e.pane, last: e, count: 0, status: null }; byOracle.set(key, o); }
    o.count++;
    if ((e.ts || 0) >= (o.last.ts || 0)) { o.last = e; o.pane = e.pane; }
    if (STATUS_RE.test(e.summary || '') && (!o.status || (e.ts || 0) >= (o.status.ts || 0))) o.status = e;
  }
  // kobo-111 — an oracle is in error if ANY of its panes' newest state is 'error'.
  // Drives the oracle-level precedence error > active > idle > offline, so a single
  // dead pane stays visible even while the oracle's other panes are busy.
  for (const st of paneState.values()) if (st.state === 'error') oraclesWithError.add(st.oracle);
  // ROSTER-ONLY (kobo-104, Tony): show ONLY /api/roster members — a worklog actor
  // NOT in the roster (a cross-company visitor: human/meganechan/tony) is no longer
  // surfaced here. Roster is authoritative membership; worklog only overlays activity.
  // kobo-105 — classify each row up front: active / idle-with-work / idle / offline.
  // idle-with-work = LOOKS idle (no worklog activity for ACTIVE_MS) but holds an
  // open claim or in-progress card → a possible deadlock, surfaced amber. offline
  // (no worklog activity at all) is left unchanged even if it holds work: that is
  // a different signal (pane gone), a later iteration if wanted (spec, YAGNI).
  const now = nowMs();
  const rows = [];
  for (const r of roster) {
    const act = byOracle.get(r.oracle) || null;
    const errored = oraclesWithError.has(r.oracle); // kobo-111 — highest precedence
    const active = !errored && !!(act && (now - (act.last.ts || 0)) <= ACTIVE_MS);
    const heldWork = held[r.oracle] || [];
    const idleWithWork = !errored && !active && !!act && heldWork.length > 0;
    rows.push({ member: r, act, errored, active, heldWork, idleWithWork });
  }
  if (!rows.length) { host.appendChild(el('div', 'empty', 'no roster members')); return; }
  // kobo-111 precedence: error first (🛑 a dead pane must not hide), then active, then
  // idle-with-work (⚠️ surface deadlocks), then by most-recent activity, then alphabetical.
  rows.sort((a, b) => {
    const rank = (x) => x.errored ? 0 : (x.active ? 1 : (x.idleWithWork ? 2 : 3));
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = a.act ? (a.act.last.ts || 0) : 0, tb = b.act ? (b.act.last.ts || 0) : 0;
    if (tb !== ta) return tb - ta;
    return a.member.oracle.localeCompare(b.member.oracle);
  });
  const grid = el('div', 'presence-grid');
  for (const item of rows) {
    const member = item.member, act = item.act, active = item.active, idleWithWork = item.idleWithWork, errored = item.errored;
    const cell = el('div', 'presence-cell' + (errored ? ' is-error' : (active ? ' is-active' : (idleWithWork ? ' is-idle-work' : ''))));
    // header row: avatar + name.pane + explicit status badge (error/active/idle/offline)
    const head = el('div', 'p-head');
    // kobo-64 — per-oracle avatar (same palette/contrast as note bubbles): color =
    // identity, initials + full name always shown (color-not-only). Presentation only.
    const avc = authorColor(member.oracle);
    const av = el('span', 'p-avatar', authorInitials(member.oracle));
    av.style.background = avc; av.style.color = avatarText(avc);
    head.appendChild(av);
    head.appendChild(el('span', 'p-oracle', member.oracle + (act && act.pane ? '.' + act.pane : '')));
    // kobo-103/105/111 — labelled status badge: error (🛑) / active / idle-with-work (⚠️) / idle / offline.
    const badgeCls = errored ? 'p-badge error' : (active ? 'p-badge active' : (idleWithWork ? 'p-badge idle-work' : (act ? 'p-badge idle' : 'p-badge')));
    const badgeTxt = errored ? '🛑 error' : (active ? '● active' : (idleWithWork ? '⚠️ idle · มีงานค้าง' : (act ? '○ idle' : '— offline')));
    const badge = el('span', badgeCls, badgeTxt);
    badge.title = errored ? 'a pane ended its last turn on an API error (rate-limit / overload) — see the red pane below; clears on the next prompt'
      : (active ? 'active (activity in the last 10 min)'
      : (idleWithWork ? 'idle for 10+ min but still holding work (open claim / in-progress card) — possible deadlock'
      : (act ? 'idle (no activity in the last 10 min)' : 'no recent activity')));
    head.appendChild(badge);
    cell.appendChild(head);
    const roleTxt = member.role ? (member.role + (member.dept ? ' · ' + member.dept : '')) : (member.dept || '');
    if (roleTxt) cell.appendChild(el('div', 'p-role', roleTxt));
    if (act) {
      cell.appendChild(el('div', 'p-when', (act.last.iso ? relTime(act.last.ts) + ' · ' + localTs(act.last.iso) : text(act.last.ts)) + ' · ' + act.count + ' event' + (act.count === 1 ? '' : 's')));
      cell.appendChild(el('div', 'p-last', (act.last.kind || 'tool') + ' · ' + (act.last.summary || '')));
      if (act.status) cell.appendChild(el('div', 'p-status', '⚑ status: ' + (act.status.summary || '') + ' (' + relTime(act.status.ts) + ')'));
    } else {
      cell.appendChild(el('div', 'p-count', 'no recent activity'));
    }
    // kobo-105 — when idle-but-holding-work, list what it holds so a human can
    // see WHAT is stuck (claim/card ids), not just that something is.
    if (idleWithWork) {
      const box = el('div', 'p-held');
      box.appendChild(el('span', 'p-held-label', 'holding:'));
      for (const h of item.heldWork) {
        box.appendChild(el('span', 'p-held-item', h.id + ' (' + h.kind + ')'));
      }
      cell.appendChild(box);
    }
    // kobo-104/108 — per-pane model + context% sub-rows (option C). A stale pane
    // (statusline stopped re-rendering while idle → frozen ts) still shows its
    // LAST-KNOWN model + ctx%, dimmed via is-stale — the file data is intact, so
    // blanking it to "unknown"/"—" only hid live info (kobo-108).
    const panes = panesByOracle.get(member.oracle) || [];
    if (panes.length) {
      const box = el('div', 'p-panes');
      for (const p of panes) {
        // kobo-109/111 — per-pane work-state from THIS pane's newest persisted event (%N join):
        // error event (Stop + API error) → error, idle event (Stop) → idle, any activity → busy.
        // Durable across restart. A pane with no event yet (statusline present, no worklog
        // activity) → idle. 3 states mutually-exclusive, newest-wins (next prompt clears error).
        const st = paneState.get(p.pane);
        const pState = st ? st.state : 'idle'; // 'busy' | 'idle' | 'error'
        const row = el('div', 'p-pane-row' + (p.stale ? ' is-stale' : '') + (pState === 'busy' ? ' is-pane-busy' : '') + (pState === 'error' ? ' is-pane-error' : ''));
        if (p.stale) row.title = 'last known — statusline stale 5+ min (context readout may be outdated)';
        row.appendChild(el('span', 'p-pane-id', '.' + (p.pane || '?')));
        row.appendChild(el('span', 'p-pane-model', p.model || '—'));
        const pct = ctxPct(p);
        const ctx = el('span', 'p-pane-ctx', pct == null ? 'ctx —' : 'ctx ' + pct + '%');
        if (pct != null && !p.stale) { ctx.title = pct + '% context remaining'; }
        row.appendChild(ctx);
        const pbTxt = pState === 'error' ? '🛑 error' : (pState === 'busy' ? '● busy' : '○ idle');
        const pbadge = el('span', 'p-pane-badge ' + pState, pbTxt);
        pbadge.title = pState === 'error' ? 'this pane ended its last turn on an API error (rate-limit / overload) — clears on the next prompt'
                     : (pState === 'busy' ? 'busy — feed activity from this pane in the last 10 min'
                     : 'idle — no feed activity from this pane in the last 10 min');
        row.appendChild(pbadge);
        box.appendChild(row);
      }
      cell.appendChild(box);
    }
    grid.appendChild(cell);
  }
  host.appendChild(grid);
}

// kobo-49 c5 — tab shell. Only one tabpanel visible at a time; the dynamic tabs
// (worklog/presence) re-render from the cached feed on show + on each poll while active.
let activeTab = 'kanban';
function showTab(name) {
  activeTab = name;
  for (const p of document.querySelectorAll('.tabpanel')) p.hidden = (p.dataset.tab !== name);
  for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
  if (name === 'worklog') renderTimeline(lastEntries);
  else if (name === 'presence') renderPresence(lastEntries, lastRoster, lastPresence, lastHeld);
  else if (name === 'state') renderState(lastState);
  try { localStorage.setItem('maw-company-tab', name); } catch (e) { /* private mode */ }
}
function updateTabCounts() {
  const wlCount = lastEntries.filter((e) => e.kind !== 'idle').length; // kobo-109: idle = pane-state, not timeline
  $('tab-count-worklog').textContent = wlCount ? '(' + wlCount + ')' : '';
  // Presence count = full membership (roster ∪ any active-but-unrostered oracle), kobo-50.
  const names = new Set(lastRoster.map((r) => r.oracle));
  for (const e of lastEntries) names.add(e.oracle || '?');
  $('tab-count-presence').textContent = names.size ? '(' + names.size + ')' : '';
}

// Minimal, escape-first markdown→HTML for the markdown-file panel. We escape & <
// > FIRST, then apply formatting, so company state.md can never inject HTML.
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inlineMd(s) {
  return s
    .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdToHtml(src) {
  const lines = escapeHtml(src).split(/\\r?\\n/);
  const out = [];
  let i = 0, inCode = false, listType = null;
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\\s*\`\`\`/.test(line)) {
      if (!inCode) { closeList(); out.push('<pre><code>'); inCode = true; }
      else { out.push('</code></pre>'); inCode = false; }
      i++; continue;
    }
    if (inCode) { out.push(line); i++; continue; }
    if (/^\\s*$/.test(line)) { closeList(); i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\\s+(.*)$/))) { closeList(); const lv = m[1].length; out.push('<h' + lv + '>' + inlineMd(m[2]) + '</h' + lv + '>'); i++; continue; }
    if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) { closeList(); out.push('<hr/>'); i++; continue; }
    if ((m = line.match(/^\\s*>\\s?(.*)$/))) { closeList(); out.push('<blockquote>' + inlineMd(m[1]) + '</blockquote>'); i++; continue; }
    if ((m = line.match(/^\\s*[-*+]\\s+(.*)$/))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } const cb = m[1].match(/^\\[([ xX])\\]\\s+(.*)$/); if (cb) { const done = cb[1] !== ' '; out.push('<li class="chk"><input type="checkbox" disabled' + (done ? ' checked' : '') + '/>' + (done ? '<span class="done">' + inlineMd(cb[2]) + '</span>' : inlineMd(cb[2])) + '</li>'); } else { out.push('<li>' + inlineMd(m[1]) + '</li>'); } i++; continue; }
    if ((m = line.match(/^\\s*\\d+\\.\\s+(.*)$/))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inlineMd(m[1]) + '</li>'); i++; continue; }
    closeList(); out.push('<p>' + inlineMd(line) + '</p>'); i++;
  }
  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\\n');
}

// kobo-60 — structured card-detail body. Fleet card bodies are dominated by
// "**field:** value" lines + a "**scope:**" checklist; mdToHtml flattened those
// into an undifferentiated mono wall (Tony's daily pain). Split BEFORE markdown:
//   - "**label:** value"           → fieldBlock (colored left-border + label + value)
//   - "**scope:**" + "- [ ] …" run → scopeBlock (progress bar + checklist)
//   - everything else              → prose chunk via mdToHtml (sans, .md)
// Escape-first throughout (escapeHtml→inlineMd); structure via el()/textContent.
function fieldKind(label) {
  const l = label.toLowerCase();
  if (/source|target|host|repo|origin|from\\b/.test(l)) return 'source';
  if (/premise|interim|assumption|caution|workaround|temp\\b/.test(l)) return 'premise';
  if (/bug|อาการ|problem|issue|broken|error|risk/.test(l)) return 'bug';
  if (/accept|acceptance|decision|verdict|เลือก|go\\b|result/.test(l)) return 'accept';
  if (/dep|epic|parent|queue|meta|ref|link|note/.test(l)) return 'meta';
  return '';
}
function fieldBlock(label, value) {
  const kind = fieldKind(label);
  const block = el('div', 'field' + (kind ? ' field-' + kind : ''));
  block.appendChild(el('span', 'field-label', label));
  const val = el('div', 'field-val');
  if (value) val.innerHTML = inlineMd(escapeHtml(value)); // escape-first → XSS-safe
  block.appendChild(val);
  return block;
}
function scopeBlock(label, items) {
  const total = items.length;
  const done = items.filter(function (x) { return x.done; }).length;
  const block = el('div', 'scope-block');
  const head = el('div', 'scope-head');
  head.appendChild(el('span', 'scope-title', label));
  if (total) {
    const prog = el('div', 'scope-prog');
    prog.setAttribute('role', 'progressbar');
    prog.setAttribute('aria-label', done + ' of ' + total + ' done');
    prog.setAttribute('aria-valuemin', '0');
    prog.setAttribute('aria-valuemax', String(total));
    prog.setAttribute('aria-valuenow', String(done));
    prog.appendChild(el('span', 'scope-count', done + '/' + total));
    const bar = el('div', 'scope-bar');
    const fill = el('div', 'scope-fill');
    fill.style.width = Math.round((done / total) * 100) + '%';
    bar.appendChild(fill);
    prog.appendChild(bar);
    head.appendChild(prog);
  }
  block.appendChild(head);
  const list = el('div', 'scope-list');
  for (const it of items) {
    const row = el('div', 'scope-item' + (it.done ? ' done' : ''));
    const box = el('input'); box.type = 'checkbox'; box.disabled = true; box.checked = it.done;
    const txt = el('span', 'scope-txt');
    txt.innerHTML = inlineMd(escapeHtml(it.text)); // escape-first
    row.appendChild(box); row.appendChild(txt);
    list.appendChild(row);
  }
  block.appendChild(list);
  return block;
}
function renderCardBody(body) {
  const frag = document.createDocumentFragment();
  const lines = String(body).split(/\\r?\\n/);
  let prose = [];
  const flushProse = function () {
    const txt = prose.join('\\n').trim();
    prose = [];
    if (!txt) return;
    const d = el('div', 'md');
    d.innerHTML = mdToHtml(txt); // mdToHtml is escape-first
    frag.appendChild(d);
  };
  let i = 0;
  while (i < lines.length) {
    const fm = lines[i].match(/^\\s*\\*\\*\\s*([^*:]+?)\\s*:\\*\\*\\s*(.*)$/);
    if (fm) {
      const label = fm[1].trim();
      const rest = fm[2].trim();
      // scope/checklist header (value empty) → gather the following "- [ ] …" run
      if (/^(scope|checklist|steps?|todo)\\b/i.test(label) && !rest) {
        i++;
        const items = [];
        let cm;
        while (i < lines.length && (cm = lines[i].match(/^\\s*[-*+]\\s+\\[([ xX])\\]\\s+(.*)$/))) {
          items.push({ done: cm[1] !== ' ', text: cm[2].trim() });
          i++;
        }
        if (items.length) { flushProse(); frag.appendChild(scopeBlock(label, items)); continue; }
        // no checklist followed → fall through as a plain field
        flushProse(); frag.appendChild(fieldBlock(label, rest)); continue;
      }
      flushProse();
      frag.appendChild(fieldBlock(label, rest));
      i++;
      continue;
    }
    prose.push(lines[i]);
    i++;
  }
  flushProse();
  return frag;
}

// kobo-127 — state.md now lives in its OWN "State" tab (Kanban = board only). The
// panel is always mounted in the state tabpanel; renderState fills it or shows an
// empty note, and the State tab-count carries a ● dot when a state.md exists.
function renderState(state) {
  const md = $('state-md');
  if (!state || !state.exists || !state.markdown) {
    md.replaceChildren(el('div', 'empty', 'no state.md for this company'));
    $('tab-count-state').textContent = '';
    return;
  }
  md.innerHTML = mdToHtml(state.markdown);
  $('tab-count-state').textContent = ' ●';
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.json();
}

async function load() {
  const company = currentCompany();
  $('co-name').textContent = company || '—';
  if (!company) { statusEl.textContent = 'specify ?company= (e.g. /company?company=pgw)'; lastTasks = []; lastEntries = []; lastRoster = []; lastHeld = {}; lastPresence = []; lastState = null; buildIndex([]); renderBoard([]); renderTimeline([]); renderState(null); updateTabCounts(); if (activeTab === 'presence') renderPresence([], [], [], {}); return; }
  statusEl.textContent = 'loading…';
  statusEl.className = '';
  try {
    const q = '?company=' + encodeURIComponent(company);
    // state panel + roster are optional — a failed/absent one must not break the page.
    const [tasksRes, feedRes, stateRes, rosterRes, presenceRes] = await Promise.all([
      getJson('/api/tasks' + q),
      getJson('/api/worklog/feed' + q + '&limit=200'), // wider window feeds the Worklog + Presence tabs (kobo-49)
      getJson('/api/state' + q).catch(() => null),
      getJson('/api/roster' + q).catch(() => null), // authoritative company membership (kobo-50)
      getJson('/api/presence').catch(() => null), // per-pane model + ctx% overlay (kobo-104) — host-wide, matched to roster by oracle
    ]);
    const tasks = Array.isArray(tasksRes.tasks) ? tasksRes.tasks : [];
    const entries = Array.isArray(feedRes.entries) ? feedRes.entries : [];
    const roster = rosterRes && Array.isArray(rosterRes.roster) ? rosterRes.roster : [];
    const held = rosterRes && rosterRes.held && typeof rosterRes.held === 'object' ? rosterRes.held : {}; // kobo-105
    const presence = presenceRes && Array.isArray(presenceRes.rows) ? presenceRes.rows : [];
    lastTasks = tasks;
    lastEntries = entries;
    lastRoster = roster;
    lastHeld = held;
    lastPresence = presence;
    lastState = stateRes;
    buildIndex(tasks); // full-list index for rollup / parent-chip / family derivation
    renderBoard(tasks);
    renderTimeline(entries);
    renderState(stateRes);
    updateTabCounts();
    if (activeTab === 'presence') renderPresence(entries, roster, presence, held); // keep the live tab fresh on poll
    const wlN = entries.filter((e) => e.kind !== 'idle').length; // kobo-109: exclude pane-state idle events
    statusEl.textContent = tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' · ' + wlN + ' worklog entr' + (wlN === 1 ? 'y' : 'ies') + (stateRes && stateRes.exists ? ' · state.md' : '');
  } catch (err) {
    statusEl.textContent = 'failed to load: ' + (err && err.message ? err.message : err);
    statusEl.className = 'error';
  }
}

function companyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('company') || '').trim();
}

// kobo-181: deep-link the open card in the URL (?card=<id>), preserving ?company.
// openDetail pushes a history entry only when SWITCHING card (same id = a reopen
// after a write → no spurious entry); closeDetail drops the param in place. A
// popstate (back/forward) syncs the modal to the URL. Vanilla history API — no router.
function cardFromUrl() { return parseCardId(window.location.search); }
function syncUrlToCard(id) {
  if (cardFromUrl() === id) return; // already on this card (reopen / popstate) → no new entry
  const u = new URL(window.location.href);
  u.searchParams.set('card', id);
  window.history.pushState({ card: id }, '', u.toString());
}
function dropCardFromUrl() {
  if (!cardFromUrl()) return; // nothing to drop (e.g. closed via back button already)
  const u = new URL(window.location.href);
  u.searchParams.delete('card');
  window.history.replaceState(null, '', u.toString());
}
function syncModalToUrl() { // popstate: make the DOM match wherever we navigated to
  const id = cardFromUrl();
  const t = id ? taskIndex.byId.get(id) : null;
  if (t) openDetail(t); // URL already has ?card=id → openDetail won't re-push
  else closeDetail();   // no card (or unknown id) → ensure the modal is closed
}

// Theme — default dark (the board's native look); persisted per browser.
const themeBtn = $('theme');
function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  themeBtn.textContent = light ? '☀️' : '🌙';
}
function currentTheme() {
  try { return localStorage.getItem('maw-company-theme') || 'dark'; } catch (e) { return 'dark'; }
}
applyTheme(currentTheme());
themeBtn.addEventListener('click', () => {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  try { localStorage.setItem('maw-company-theme', next); } catch (e) { /* private mode — session-only */ }
  applyTheme(next);
});

companyInput.value = companyFromUrl();
companyInput.addEventListener('change', () => {
  const u = new URL(window.location.href);
  u.searchParams.set('company', currentCompany());
  window.history.replaceState(null, '', u.toString());
  load();
});
$('refresh').addEventListener('click', load);
wireColumnCollapse(); // kobo-194 — chevron toggles for collapsible columns (once; applyColumnCollapse runs each render)
applyColumnCollapse(); // fold to persisted state before the first load paints
// kobo-49 c5 — tab switching + restore the last-used tab per browser.
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
(function () { let t = 'kanban'; try { t = localStorage.getItem('maw-company-tab') || 'kanban'; } catch (e) { /* private mode */ } if (!document.querySelector('.tab[data-tab="' + t + '"]')) t = 'kanban'; showTab(t); })();
// kobo-44 modal close paths: ✕ button, backdrop click (target === overlay only,
// not clicks inside the dialog), Esc, and a basic focus trap so Tab stays inside.
$('detail-close').addEventListener('click', closeDetail);
$('detail-overlay').addEventListener('click', (ev) => { if (ev.target === $('detail-overlay')) closeDetail(); });
document.addEventListener('keydown', (ev) => {
  if ($('detail-overlay').hidden) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closeDetail(); return; }
  if (ev.key !== 'Tab') return;
  const panel = $('detail-panel');
  const focusable = panel.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) { ev.preventDefault(); panel.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || active === panel)) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
});
// kobo-181: back/forward syncs the modal to the URL (open ?card, or close if gone).
window.addEventListener('popstate', syncModalToUrl);
// Initial load; once tasks are indexed, open the deep-linked card (?card=<id>) if
// any. One-shot on boot — the 5s poll calls load() directly and must NOT reopen.
// An unknown id just no-ops (taskIndex miss) — a stale/shared link never crashes.
load().then(() => {
  const cid = cardFromUrl();
  if (!cid) return;
  const t = taskIndex.byId.get(cid);
  if (t) openDetail(t);
});

// kobo-37: auto-refresh — poll every 5s so the board tracks changes without F5.
// Pause while the tab is hidden (don't hammer in the background); on re-show,
// reload immediately + resume so a returning tab is never stale.
// ponytail: setInterval poll, not SSE/websocket — one viewer on localhost, 3
// tiny GETs every 5s is far cheaper than building+maintaining a push channel.
// The open detail panel survives a poll for free: load() re-renders
// board/timeline/state but never touches #detail-panel, so a card you're
// reading stays open. Upgrade path if the board ever grows many live viewers:
// swap this block for an SSE endpoint fed by the worklog append.
const POLL_MS = 5000;
let pollTimer = null;
// Poll data + version together (kobo-57) — one timer, same 5s cadence.
function tick() { load(); checkVersion(); }
function startPoll() { if (!pollTimer) pollTimer = setInterval(tick, POLL_MS); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopPoll();
  else { tick(); startPoll(); }
});
checkVersion();
startPoll();
</script>
</body>
</html>`;
}

export const companyView = new Hono();
companyView.get("/", (c) => c.html(companyHtml()));
