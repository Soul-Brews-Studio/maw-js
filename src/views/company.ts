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
 *   - kanban        backlog→todo→in-progress→review→done + blocked (off-flow)
 *                   (off-flow) · wait-for badge derived · from GET /api/tasks
 *   - worklog-feed  activity timeline        from GET /api/worklog/feed?company=<c>
 *   - markdown-file coordination state doc   from GET /api/state?company=<c>
 *                   (hidden when the company has no state.md — never an error)
 *
 * Generic via ?company= → same renderer serves kobo, pgw, … Interactive
 * drag/write is a later phase (see spec §6/§9). For now: poll + refresh.
 */

/** Render the board HTML, stamping the live version into the placeholders. */
export function companyHtml(): string {
  return companyBody().replaceAll(VERSION_TOKEN, companyVersion());
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
    .board { display:grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap:10px; overflow-x:auto; }
    .col { background:var(--col); border:1px solid var(--line); border-radius:12px; padding:10px; min-height:120px; }
    .col h2 { margin:0 0 10px; font-size:12px; font-weight:600; color:var(--muted); display:flex; justify-content:space-between; gap:6px; }
    .col h2 .count { color:var(--fg); }
    .col-backlog h2 { color:var(--muted); } .col-todo h2 { color:var(--warn); }
    .col-in-progress h2 { color:var(--accent); } .col-review h2 { color:var(--epic); } .col-done h2 { color:var(--ok); }
    .col-rejected h2 { color:var(--warn); } /* kobo-101 — terminal "not accepted", parallel to Done */
    /* kobo-55 — the Blocked/attention lane sits ABOVE the board (top of the Kanban
       tab) so blocked/needs-attention cards are seen immediately, not below-fold on
       a busy board. Hidden entirely when nothing is off-flow (renderBoard toggles
       [hidden]) so it costs no space then. margin-bottom separates it from the board. */
    .attention { margin-bottom:14px; border:1px solid var(--bd-bad); background:#1b1012; border-radius:12px; padding:10px; }
    body.light .attention { border-color:#e6b3ad; background:#fdeeec; } /* light-theme tint (was dark-only hex) */
    .attention h2 { margin:0 0 8px; font-size:12px; color:var(--bad); display:flex; justify-content:space-between; }
    .attention .lane { display:flex; gap:9px; flex-wrap:wrap; }
    .attention .task { flex:1 1 220px; max-width:340px; }
    .task { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:var(--r-md); padding:var(--s-3) var(--s-4); margin-bottom:var(--s-3); }
    /* kobo-62 — state-accent left border: the card tells its own state at a glance
       (redundant with the column, so state is never conveyed by color alone). */
    .task.st-backlog { border-left-color:var(--muted); }
    .task.st-todo { border-left-color:var(--warn); }
    .task.st-in-progress { border-left-color:var(--accent); }
    .task.st-review { border-left-color:var(--epic); }
    .task.st-done { border-left-color:var(--ok); }
    .task.st-blocked { border-left-color:var(--bad); }
    /* kobo-62 — progressive card face: title + assignee avatar on one row. */
    .task .t-head { display:flex; align-items:flex-start; gap:var(--s-3); }
    .task .t-title { color:var(--fg); flex:1 1 auto; min-width:0; }
    .task .t-avatar { flex:0 0 auto; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:var(--t-xs); font-weight:700; letter-spacing:.02em; }
    .task .t-avatar.unassigned { background:var(--field-bg); border:1px dashed var(--line); color:var(--muted); }
    .task .t-meta { color:var(--muted); font-size:var(--t-sm); margin-top:var(--s-2); display:flex; gap:var(--s-2); flex-wrap:wrap; align-items:center; }
    .task .t-id { margin-left:auto; font-family:var(--font-mono); font-size:var(--t-xs); color:var(--muted); opacity:.8; }
    /* kobo-62 — checklist mini progress bar (was ☑N/M text). */
    .check-bar { display:inline-flex; align-items:center; gap:var(--s-2); }
    .check-track { width:56px; height:5px; background:var(--field-bg); border:1px solid var(--line); border-radius:var(--r-pill); overflow:hidden; }
    .check-fill { display:block; height:100%; background:var(--epic); }
    .check-count { font-size:var(--t-xs); color:var(--muted); font-variant-numeric:tabular-nums; }
    /* kobo-62 — detail modal meta row (dept / parent / wait moved off the face). */
    #detail-meta { display:flex; gap:var(--s-2); flex-wrap:wrap; margin-bottom:var(--s-4); }
    #detail-meta[hidden] { display:none; }
    .task .t-na { color:var(--accent); font-size:var(--t-sm); margin-top:var(--s-2); }
    .task .t-actions { margin-top:8px; display:flex; justify-content:flex-end; }
    .archive-btn { font-size:11px; padding:3px 9px; border-radius:8px; border:1px solid var(--bd-ok); color:var(--ok); background:var(--field-bg); cursor:pointer; }
    .archive-btn:hover { border-color:var(--ok); }
    .archive-btn:disabled { opacity:.55; cursor:default; }
    /* kobo-50 — mark-done button in the modal write section (pairs with archive). */
    .done-btn { align-self:flex-start; font-size:12px; padding:6px 12px; border-radius:8px; border:1px solid var(--bd-ok); color:var(--ok); background:var(--field-bg); cursor:pointer; }
    .done-btn:hover { border-color:var(--ok); }
    .done-btn:disabled { opacity:.55; cursor:default; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 7px; white-space:nowrap; }
    .pill.dept { color:var(--accent); } .pill.epic { color:var(--epic); } .pill.assignee { color:var(--ok); }
    .pill.pr { color:var(--warn); } .pill.wait { color:var(--warn); border-color:var(--bd-warn); }
    .pill.check { color:var(--epic); }
    .pill.attn { color:var(--bad); border-color:var(--bd-bad); }
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
    #detail-notes .note-body { color:var(--fg); font-size:13px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
    /* kobo-44: card detail as a modal overlay (was an inline sidebar panel). */
    .overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:24px; z-index:50; }
    .overlay[hidden] { display:none; }
    .modal { width:min(680px, 100%); max-height:85vh; overflow:auto; margin:0; box-shadow:0 12px 40px rgba(0,0,0,.5); }
    .modal .md { max-height:none; }
    #detail-close { cursor:pointer; color:var(--muted); background:none; border:0; font:inherit; line-height:1; padding:2px 6px; border-radius:6px; }
    #detail-close:hover, #detail-close:focus-visible { color:var(--fg); outline:none; box-shadow:0 0 0 2px var(--accent); }
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
    .presence-cell .p-head { display:flex; align-items:center; gap:var(--s-3); }
    .presence-cell .p-avatar { flex:0 0 auto; width:26px; height:26px; border-radius:var(--r-pill); display:flex; align-items:center; justify-content:center; font-size:var(--t-xs); font-weight:700; letter-spacing:.02em; }
    .presence-cell .p-oracle { color:var(--accent); font-weight:600; font-size:var(--t-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .presence-cell .p-badge { margin-left:auto; flex:0 0 auto; font-size:var(--t-xs); font-weight:600; padding:2px var(--s-3); border-radius:var(--r-pill); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
    .presence-cell .p-badge.active { color:var(--ok); border-color:var(--ok); }
    .presence-cell .p-badge.idle { color:var(--st-meta); }
    .presence-cell .p-role { color:var(--muted); font-size:var(--t-sm); }
    .presence-cell .p-when { color:var(--muted); font-size:var(--t-sm); }
    .presence-cell .p-count { color:var(--muted); font-size:var(--t-xs); }
    .presence-cell .p-status { color:var(--st-meta); font-size:var(--t-sm); }
    .presence-cell .p-last { color:var(--fg); font-size:var(--t-sm); white-space:pre-wrap; word-break:break-word; }
    /* kobo-104 — per-pane model + context% sub-rows */
    .presence-cell .p-panes { display:flex; flex-direction:column; gap:var(--s-1); margin-top:var(--s-1); padding-top:var(--s-2); border-top:1px dashed var(--line); }
    .presence-cell .p-pane-row { display:flex; align-items:baseline; gap:var(--s-2); font-size:var(--t-xs); }
    .presence-cell .p-pane-row.is-stale { opacity:.55; }
    .presence-cell .p-pane-id { flex:0 0 auto; color:var(--st-meta); font-variant-numeric:tabular-nums; }
    .presence-cell .p-pane-model { flex:1 1 auto; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .presence-cell .p-pane-ctx { flex:0 0 auto; color:var(--muted); font-variant-numeric:tabular-nums; }
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
    <button type="button" class="tab" data-tab="worklog" role="tab" aria-selected="false">Worklog<span class="tab-count" id="tab-count-worklog"></span></button>
    <button type="button" class="tab" data-tab="presence" role="tab" aria-selected="false">Presence<span class="tab-count" id="tab-count-presence"></span></button>
  </nav>
  <main>
    <section class="tabpanel" data-tab="kanban" role="tabpanel">
      <div class="card">
        <div class="family-bar" id="family-bar" hidden></div>
        <div class="attention" id="attention-panel" hidden>
          <h2><span>⚑ Blocked <span style="color:var(--muted);font-weight:400">(off-flow)</span></span><span class="count" id="c-blocked">0</span></h2>
          <div class="lane" id="blocked"></div>
        </div>
        <div class="board">
          <div class="col col-backlog"><h2><span>Backlog</span><span class="count" id="c-backlog">0</span></h2><div id="backlog"></div></div>
          <div class="col col-todo"><h2><span>Todo</span><span class="count" id="c-todo">0</span></h2><div id="todo"></div></div>
          <div class="col col-in-progress"><h2><span>In&nbsp;progress</span><span class="count" id="c-in-progress">0</span></h2><div id="in-progress"></div></div>
          <div class="col col-review"><h2><span>Review</span><span class="count" id="c-review">0</span></h2><div id="review"></div></div>
          <div class="col col-done"><h2><span>Done</span><span class="count" id="c-done">0</span></h2><div id="done"></div></div>
          <div class="col col-rejected"><h2><span>Rejected</span><span class="count" id="c-rejected">0</span></h2><div id="rejected"></div></div>
        </div>
      </div>
      <div class="card" id="state-panel" style="margin-top:16px" hidden>
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
      <div id="detail-title" style="font-weight:600;margin-bottom:8px"></div>
      <div id="detail-meta"></div>
      <div class="md" id="detail-body"></div>
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
let lastPresence = []; // cached per-pane presence rows (GET /api/presence) — model + ctx% overlay (kobo-104)
let familyFilter = null; // root card id while filtering to one family, else null

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
function taskCard(task) {
  const card = el('div', 'task st-' + (task.state || 'todo')); // state-accent (left border)
  const head = el('div', 't-head');
  head.appendChild(el('div', 't-title', task.title || '(untitled)'));
  head.appendChild(assigneeAvatar(task.assignee)); // core: who owns it
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
  if (task.checklist && task.checklist.total) meta.appendChild(checklistBar(task.checklist.done, task.checklist.total));
  if (task.pr) meta.appendChild(el('span', 'pill pr', 'PR #' + task.pr));
  // blocked-lane reason signals — explain WHY a card is off-flow (only set on such cards).
  if (task.block) meta.appendChild(el('span', 'pill attn', '⚑ ' + task.block.kind + (task.block.for ? ' →' + task.block.for : '') + (task.block.reason ? ': ' + task.block.reason : '')));
  if (task.dependency && task.dependency.blockedBy.length) meta.appendChild(el('span', 'pill attn', '🚫 รอ: ' + task.dependency.blockedBy.join(', ')));
  if (task.dependency && task.dependency.missing.length) meta.appendChild(el('span', 'pill wait', '⚠ parent ไม่พบ: ' + task.dependency.missing.join(', ')));
  if (task.needsOwner) meta.appendChild(el('span', 'pill attn', '⚑ ยังไม่มีเจ้าของ')); // derived needs-owner (kobo-14)
  meta.appendChild(el('span', 't-id', text(task.id))); // id demoted — subtle, pushed right
  card.appendChild(meta);
  // next-action — the board always says what happens next + who (Track 4)
  if (task.nextAction) card.appendChild(el('div', 't-na', '↳ ' + task.nextAction));
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
  main.appendChild(el('div', 'note-body', n.text || ''));
  note.appendChild(main);
  return note;
}

function openDetail(task) {
  $('detail-title').textContent = (task.id ? task.id + ' · ' : '') + (task.title || '(untitled)');
  renderDetailMeta(task); // kobo-62: dept / parent-chip / wait moved off the card face → here
  const bodyEl = $('detail-body');
  if (task.body) { bodyEl.replaceChildren(renderCardBody(task.body)); } // kobo-60: structured field/scope blocks + prose
  else { const p = el('p', '', '(no detail — add one with: maw company task add ... --body)'); p.style.color = 'var(--muted)'; bodyEl.replaceChildren(p); }
  // kobo-39: append-only notes timeline (who / when / what) below the body. Reuse
  // the worklog .entry/.e-* classes. el() sets textContent → escape-first, XSS-safe.
  const notesEl = $('detail-notes');
  notesEl.replaceChildren();
  const notes = task.notes || [];
  if (notes.length) {
    notesEl.appendChild(el('div', 'notes-head', 'notes (' + notes.length + ')'));
    for (const n of notes) notesEl.appendChild(noteBubble(n)); // oldest-first = a timeline
  }
  // kobo-47: an epic's modal also gathers notes from every child card, oldest-first,
  // each tagged with its source child id. Derived at read (childNotesOf prefers a
  // server task.childNotes, else aggregates the payload's children). Own vs. sub
  // notes are kept in separate sections so the source is never ambiguous.
  const childNotes = childNotesOf(task);
  if (childNotes.length) {
    notesEl.appendChild(el('div', 'notes-head', 'notes from subtasks (' + childNotes.length + ')'));
    for (const n of childNotes) notesEl.appendChild(noteBubble(n, n.from));
  }
  // kobo-48: write controls (+ subtask, comment box) live inside the modal.
  buildWriteSection(task);
  openModal();
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

  // comment
  const cmtRow = el('div', 'write-row');
  cmtRow.appendChild(el('label', '', 'comment (notifies the assignee)'));
  const cmtLine = el('div', 'row');
  const cmtInput = el('textarea'); cmtInput.placeholder = 'comment… (⌘/Ctrl+Enter to send)';
  const cmtBtn = el('button', '', 'comment'); cmtBtn.type = 'button';
  cmtLine.appendChild(cmtInput); cmtLine.appendChild(cmtBtn);
  cmtRow.appendChild(cmtLine);

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

  wrap.appendChild(subRow); wrap.appendChild(cmtRow); wrap.appendChild(msg);

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
      await postJson('/api/tasks/note', { company: company, id: task.id, text: t });
      cmtInput.value = '';
      setMsg('comment added', true);
      await load();
      reopenDetail(task.id); // refresh the notes timeline
    } catch (err) { setMsg('comment failed: ' + errMsg(err), false); }
    finally { cmtBtn.disabled = false; }
  }
  subBtn.addEventListener('click', submitSub);
  subInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitSub(); } });
  cmtBtn.addEventListener('click', submitCmt);
  cmtInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitCmt(); } });
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
  $('detail-overlay').hidden = true;
  if (detailReturnFocus && detailReturnFocus.focus) detailReturnFocus.focus();
  detailReturnFocus = null;
}

const FLOW = ['backlog', 'todo', 'in-progress', 'review', 'done'];
const COLS = ['backlog', 'todo', 'in-progress', 'review', 'done', 'rejected']; // board columns = flow + Rejected terminal lane (kobo-101)

function renderBoard(tasks) {
  // Family filter is display-only — taskIndex stays built over the FULL list so
  // rollup / parent-chip / family membership still resolve against every card.
  updateFamilyBar();
  const fam = familyFilter ? familyMembers(familyFilter) : null;
  const shown = fam ? tasks.filter((t) => fam.has(t.id)) : tasks;
  const cols = {};
  // COLS = the linear flow + the parallel terminal Rejected lane (kobo-101). Both
  // are real board columns; the Blocked lane is separate (off-flow, below).
  for (const s of COLS) { cols[s] = $(s); cols[s].replaceChildren(); }
  const attn = $('blocked'); attn.replaceChildren();
  const counts = { backlog: 0, todo: 0, 'in-progress': 0, review: 0, done: 0, rejected: 0, blocked: 0 };
  // Off-flow = explicit block (state) OR derived dependency block (ADR 0003) —
  // ONE Blocked lane, mirroring the CLI board. Derived cards keep their real
  // flow state but are pulled out while a parent is pending; when the parent is
  // done the next poll drops the dependency field and the card returns.
  const isOffFlow = (task) => task.state === 'blocked' || (task.dependency && task.dependency.blockedBy.length > 0) || task.needsOwner;
  for (const task of shown) {
    if (isOffFlow(task)) { attn.appendChild(taskCard(task)); counts['blocked']++; continue; }
    const state = cols[task.state] ? task.state : 'todo';
    cols[state].appendChild(taskCard(task));
    counts[state]++;
  }
  for (const s of COLS) {
    $('c-' + s).textContent = counts[s];
    if (counts[s] === 0) cols[s].appendChild(el('div', 'empty', '—'));
  }
  $('c-blocked').textContent = counts['blocked'];
  $('attention-panel').hidden = counts['blocked'] === 0;
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
// to 100-used_percentage. null (pre-first-API-call / post-compact) or stale → null
// → the UI renders "—" instead of a misleading number. (kobo-104)
function ctxPct(p) {
  if (!p || p.stale) return null;
  if (typeof p.remaining_percentage === 'number') return Math.round(p.remaining_percentage);
  if (typeof p.used_percentage === 'number') return Math.round(100 - p.used_percentage);
  return null;
}
function renderPresence(entries, roster, presence) {
  entries = entries || []; roster = roster || []; presence = presence || [];
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
  const byOracle = new Map();
  for (const e of entries) {
    const key = e.oracle || '?';
    let o = byOracle.get(key);
    if (!o) { o = { oracle: key, pane: e.pane, last: e, count: 0, status: null }; byOracle.set(key, o); }
    o.count++;
    if ((e.ts || 0) >= (o.last.ts || 0)) { o.last = e; o.pane = e.pane; }
    if (STATUS_RE.test(e.summary || '') && (!o.status || (e.ts || 0) >= (o.status.ts || 0))) o.status = e;
  }
  // ROSTER-ONLY (kobo-104, Tony): show ONLY /api/roster members — a worklog actor
  // NOT in the roster (a cross-company visitor: human/meganechan/tony) is no longer
  // surfaced here. Roster is authoritative membership; worklog only overlays activity.
  const rows = [];
  for (const r of roster) rows.push({ member: r, act: byOracle.get(r.oracle) || null });
  if (!rows.length) { host.appendChild(el('div', 'empty', 'no roster members')); return; }
  // active first, then most-recent activity, then roster-only alphabetical.
  rows.sort((a, b) => {
    const ta = a.act ? (a.act.last.ts || 0) : 0, tb = b.act ? (b.act.last.ts || 0) : 0;
    if (tb !== ta) return tb - ta;
    return a.member.oracle.localeCompare(b.member.oracle);
  });
  const grid = el('div', 'presence-grid');
  for (const item of rows) {
    const member = item.member, act = item.act;
    const active = act && (nowMs() - (act.last.ts || 0)) <= ACTIVE_MS;
    const cell = el('div', 'presence-cell' + (active ? ' is-active' : ''));
    // header row: avatar + name.pane + explicit status badge (active/idle/offline)
    const head = el('div', 'p-head');
    // kobo-64 — per-oracle avatar (same palette/contrast as note bubbles): color =
    // identity, initials + full name always shown (color-not-only). Presentation only.
    const avc = authorColor(member.oracle);
    const av = el('span', 'p-avatar', authorInitials(member.oracle));
    av.style.background = avc; av.style.color = avatarText(avc);
    head.appendChild(av);
    head.appendChild(el('span', 'p-oracle', member.oracle + (act && act.pane ? '.' + act.pane : '')));
    // kobo-103 — status is a labelled badge, not just a dot: active / idle / offline.
    const badgeCls = active ? 'p-badge active' : (act ? 'p-badge idle' : 'p-badge');
    const badge = el('span', badgeCls, active ? '● active' : (act ? '○ idle' : '— offline'));
    badge.title = active ? 'active (activity in the last 10 min)' : (act ? 'idle (no activity in the last 10 min)' : 'no recent activity');
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
    // kobo-104 — per-pane model + context% sub-rows (option C). A ghost pane
    // (statusline stopped) is marked stale → "unknown" rather than a frozen %.
    const panes = panesByOracle.get(member.oracle) || [];
    if (panes.length) {
      const box = el('div', 'p-panes');
      for (const p of panes) {
        const row = el('div', 'p-pane-row' + (p.stale ? ' is-stale' : ''));
        row.appendChild(el('span', 'p-pane-id', '.' + (p.pane || '?')));
        row.appendChild(el('span', 'p-pane-model', p.stale ? 'unknown' : (p.model || '—')));
        const pct = ctxPct(p);
        const ctx = el('span', 'p-pane-ctx', pct == null ? 'ctx —' : 'ctx ' + pct + '%');
        if (pct != null) { ctx.title = pct + '% context remaining'; }
        row.appendChild(ctx);
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
  else if (name === 'presence') renderPresence(lastEntries, lastRoster, lastPresence);
  try { localStorage.setItem('maw-company-tab', name); } catch (e) { /* private mode */ }
}
function updateTabCounts() {
  $('tab-count-worklog').textContent = lastEntries.length ? '(' + lastEntries.length + ')' : '';
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

function renderState(state) {
  const panel = $('state-panel');
  if (!state || !state.exists || !state.markdown) { panel.hidden = true; return; }
  $('state-md').innerHTML = mdToHtml(state.markdown);
  panel.hidden = false;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.json();
}

async function load() {
  const company = currentCompany();
  $('co-name').textContent = company || '—';
  if (!company) { statusEl.textContent = 'specify ?company= (e.g. /company?company=pgw)'; lastTasks = []; lastEntries = []; lastRoster = []; lastPresence = []; buildIndex([]); renderBoard([]); renderTimeline([]); renderState(null); updateTabCounts(); if (activeTab === 'presence') renderPresence([], [], []); return; }
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
    const presence = presenceRes && Array.isArray(presenceRes.rows) ? presenceRes.rows : [];
    lastTasks = tasks;
    lastEntries = entries;
    lastRoster = roster;
    lastPresence = presence;
    buildIndex(tasks); // full-list index for rollup / parent-chip / family derivation
    renderBoard(tasks);
    renderTimeline(entries);
    renderState(stateRes);
    updateTabCounts();
    if (activeTab === 'presence') renderPresence(entries, roster, presence); // keep the live tab fresh on poll
    statusEl.textContent = tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' · ' + entries.length + ' worklog entr' + (entries.length === 1 ? 'y' : 'ies') + (stateRes && stateRes.exists ? ' · state.md' : '');
  } catch (err) {
    statusEl.textContent = 'failed to load: ' + (err && err.message ? err.message : err);
    statusEl.className = 'error';
  }
}

function companyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('company') || '').trim();
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
load();

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
