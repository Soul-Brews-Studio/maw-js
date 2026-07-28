import { Hono } from "hono";
import { escapeHtml, inlineMd, mdToHtml, NOTE_IMG_EXT, renderNoteBody } from "./md";

// Brainstorm Room — 2-pane chat (kobo-258, UX spec eq3 2026-07-10). A company-scoped
// chat surface to ground a problem with the company LEAD: LEFT = topic/room list of the
// current company · RIGHT = the conversation. Every turn is attributed (you / lead /
// teammate) by pill + alignment + colour (a11y: colour is never the only signal). The
// engine is untouched — this view only CONSUMES the existing room endpoints:
//   GET  /api/rooms?company=<c>        → { company, lead, companies[], rooms[] } (kobo-258)
//   GET  /api/room/thread?company&room → persisted thread (kobo-241)
//   GET  /api/room/activity?…          → who's-here CC-strip (kobo-242)
//   POST /api/room/open|close|send     → lifecycle + hey delivery (kobo-241/245/248)
//   POST /api/room/distill|merge       → room→card + consolidate (kobo-244/243)
// ONE template literal; keep the client JS backtick-free (string concat), like messages.ts.
export function roomHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw · brainstorm rooms</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#0F172A; --surface:#1E293B; --surface-2:#334155; --muted:#272F42; --border:#475569;
      --fg:#F8FAFC; --dim:#94A3B8; --lead:#22C55E; --human:#38BDF8; --teammate:#C084FC; --danger:#EF4444;
      --r-bubble:12px; --r-pill:999px;
    }
    * { box-sizing:border-box; }
    html,body { height:100%; }
    body { margin:0; font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
    button, select, input, textarea { font:inherit; color:var(--fg); }
    button { cursor:pointer; }
    :focus-visible { outline:2px solid var(--human); outline-offset:2px; }

    /* top bar */
    .topbar { position:sticky; top:0; z-index:5; height:56px; display:flex; align-items:center; gap:12px;
      padding:0 16px; background:var(--surface); border-bottom:1px solid var(--border); }
    .brand { font-weight:700; color:var(--lead); letter-spacing:.02em; }
    .topbar select { background:var(--muted); border:1px solid var(--border); border-radius:8px; padding:6px 10px; }
    .leadlbl { color:var(--dim); font-size:13px; }
    .leadlbl b { color:var(--lead); }
    .topbar h1 { margin:0 auto; font-size:15px; font-weight:600; color:var(--dim); }
    .primary { background:var(--lead); color:#04120A; border:none; border-radius:8px; padding:8px 14px; font-weight:600; }
    .primary:hover { filter:brightness(1.08); }

    /* 2-pane */
    .app { display:grid; grid-template-columns:minmax(260px,28%) 1fr; height:calc(100vh - 56px); }
    .topics { border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; background:var(--surface); }
    .topics h2 { margin:0; padding:14px 16px 8px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
    /* kobo-438: closed/merged rooms hide by default (Tony reversed kobo-379's
       "show, just gray it out" default) — this toggle is the ONLY way back to
       them, so it must always be visible on the list, never in a menu/hover,
       and always state its own count (even 0), never disappear. */
    #roomFilterToggle { display:block; width:calc(100% - 16px); margin:0 8px 8px; padding:7px 10px; background:var(--muted); border:1px solid var(--border); border-radius:8px; color:var(--dim); font-size:12px; text-align:left; }
    #roomFilterToggle:hover { filter:brightness(1.15); }
    #roomFilterToggle.active { color:var(--lead); border-color:var(--lead); }
    #roomlist { overflow-y:auto; flex:1; padding:0 8px 12px; }
    .roomrow { display:flex; align-items:center; gap:10px; min-height:44px; padding:8px 10px; border-radius:8px;
      cursor:pointer; border-left:2px solid transparent; transition:background .15s; }
    @media (prefers-reduced-motion:reduce) { .roomrow { transition:none; } }
    .roomrow:hover { background:var(--muted); }
    .roomrow.active { background:var(--surface-2); border-left-color:var(--lead); }
    .roomrow .dot { font-size:10px; color:var(--lead); }
    .roomrow.st-closed .dot, .roomrow.st-merged .dot { color:var(--dim); }
    .roomrow .rtopic { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .roomrow.st-merged, .roomrow.st-closed { color:var(--dim); }
    .roomrow input[type=checkbox] { width:16px; height:16px; accent-color:var(--lead); }
    .list-empty { padding:24px 16px; color:var(--dim); text-align:center; }
    .list-empty .primary { margin-top:12px; }

    /* chat */
    .chat { display:flex; flex-direction:column; min-height:0; position:relative; }
    .chat-header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); }
    .chat-header .back { display:none; background:none; border:none; color:var(--dim); font-size:20px; padding:0 4px; }
    .chat-header .htopic { font-weight:600; }
    .chat-header .hsub { color:var(--dim); font-size:13px; }
    .chat-header .spacer { flex:1; }
    .chat-header .act { background:var(--muted); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:13px; color:var(--dim); }
    .chat-header .act.accent { color:var(--lead); border-color:var(--lead); }
    #activity { display:flex; flex-wrap:wrap; gap:12px; padding:8px 16px; border-bottom:1px solid var(--border); color:var(--dim); font-size:12px; }
    #activity:empty { display:none; }
    .act-who .dot { font-size:9px; } .act-who .on { color:var(--lead); } .act-who .off { color:var(--dim); }
    .act-who .nm { color:var(--fg); }

    #thread { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
    .bubble { max-width:72%; padding:8px 12px; border-radius:var(--r-bubble); background:var(--surface); border:1px solid var(--border); }
    .bubble .head { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:13px; }
    .bubble .nm { font-weight:600; }
    .bubble .pill { font-size:11px; padding:1px 8px; border-radius:var(--r-pill); background:var(--muted); color:var(--dim); }
    .bubble .ts { margin-left:auto; color:var(--dim); font-size:11px; }
    .bubble .seqno { color:var(--dim); font-size:11px; }
    /* kobo-396: body now renders as markdown (mdToHtml) — structure (p/ul/li/h*)
       comes from real HTML, not pre-wrap; tighten prose rhythm like company.ts's .md. */
    .bubble .body { word-break:break-word; }
    .bubble .body p { margin:4px 0; } .bubble .body p:first-child { margin-top:0; } .bubble .body p:last-child { margin-bottom:0; }
    .bubble .body ul, .bubble .body ol { margin:4px 0; padding-left:20px; }
    .bubble .body h1, .bubble .body h2, .bubble .body h3, .bubble .body h4 { margin:8px 0 4px; font-size:1em; }
    /* kobo-425 — room-only (never .md, that's the board — kobo-396 extracted
       ONE renderer, but scoping the CSS keeps the two surfaces' looks separate):
       bold = highlighter pen, not just bold; a quoted block = one solid red
       box with a left border (Tony: the box IS the signal, never nested). */
    .bubble .body strong { background:rgba(250,204,21,.45); padding:0 2px; border-radius:2px; color:var(--fg); }
    .bubble .body blockquote { border-left:4px solid var(--danger); background:rgba(239,68,68,.12); color:var(--fg); margin:6px 0; padding:6px 12px; border-radius:0 6px 6px 0; }
    /* kobo-493: kobo-456's per-paragraph auto-colour (background on EVERY
       plain-text <p>, no marking required) shipped, went live, and Tony
       rejected it on sight ("ไม่ต้องเอาทั้ง paragraph" — don't take the whole
       paragraph) — reverted back to kobo-425's original design: colour is
       something the writer MARKS (**bold** → the strong rule above), never
       applied to text that wasn't marked. Do not reintroduce whole-paragraph
       background colour here without a fresh explicit ask. */
    .bubble .body code { background:var(--muted); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:.9em; }
    .bubble .body pre { background:var(--muted); border:1px solid var(--border); border-radius:6px; padding:8px; overflow:auto; }
    .bubble .body pre code { background:none; border:0; padding:0; }
    /* kobo-398: fallback/source appearance before mermaid loads (or on parse-fail);
       once swapped to an <svg> child, white-space:pre only affects text nodes. */
    .bubble .body .mermaid-src { white-space:pre; background:var(--muted); border:1px solid var(--border); border-radius:6px; padding:8px; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
    .bubble .body .mermaid-src svg { max-width:100%; height:auto; }
    /* kobo-422: once rendered, a diagram becomes a THUMBNAIL — the class is only
       added after a successful render (never on the escaped-source fallback), so
       nothing un-renderable is clickable. max-height (not overflow:hidden) lets
       the SVG's own viewBox scale the WHOLE diagram down, never cropping it. */
    .bubble .body .mermaid-src.mermaid-thumb { cursor:zoom-in; }
    .bubble .body .mermaid-src.mermaid-thumb svg { display:block; width:auto; height:auto; max-height:120px; max-width:100%; }
    /* kobo-422: click-to-zoom modal — one instance, reused for every diagram in
       the thread (populated via cloneNode on open, cleared on close). */
    .mmd-modal { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; padding:32px; }
    .mmd-modal-backdrop { position:absolute; inset:0; background:rgba(2,6,15,.72); }
    .mmd-modal-body { position:relative; max-width:min(92vw,1100px); max-height:88vh; overflow:auto; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
    .mmd-modal-body svg { display:block; max-width:100%; height:auto; }
    .mmd-modal-close { position:absolute; top:10px; right:10px; background:var(--muted); border:1px solid var(--border); border-radius:8px; width:32px; height:32px; color:var(--fg); font-size:16px; line-height:1; }
    .mmd-modal-close:hover { filter:brightness(1.15); }
    /* kobo-527: card-ref chip (message text "kobo-N" → clickable) + the modal
       content it opens — same #mermaidModal instance the diagram zoom uses. */
    .card-ref-chip { background:var(--muted); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:.9em; color:var(--human); }
    .card-ref-chip:hover { filter:brightness(1.15); }
    .card-ref-modal-title { font-size:1.1em; font-weight:700; margin-bottom:6px; }
    .card-ref-modal-meta { color:var(--dim); font-size:.9em; margin-bottom:12px; }
    /* card body markdown is outside .bubble, so it doesn't inherit .bubble .body's
       code/pre/blockquote theming — a minimal same-look-and-feel copy, additive only. */
    .card-ref-modal-body p { margin:4px 0; }
    .card-ref-modal-body code { background:var(--muted); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:.9em; }
    .card-ref-modal-body pre { background:var(--muted); border:1px solid var(--border); border-radius:6px; padding:8px; overflow:auto; }
    .card-ref-modal-body pre code { background:none; border:0; padding:0; }
    .card-ref-modal-body blockquote { border-left:4px solid var(--danger); background:rgba(239,68,68,.12); color:var(--fg); margin:6px 0; padding:6px 12px; border-radius:0 6px 6px 0; }
    .card-ref-modal-err { color:var(--danger); }
    .card-ref-modal-loading { color:var(--dim); font-style:italic; } /* kobo-538 — shown immediately, before the fetch resolves */
    .bubble .body a { color:var(--human); text-decoration:underline; }
    .bubble .body .note-img-link { display:inline-block; margin:4px 0; }
    .bubble .body .note-img { display:block; max-width:100%; max-height:320px; height:auto; border:1px solid var(--border); border-radius:9px; }
    .bubble .tag { font-size:11px; color:var(--teammate); }
    /* you = right + sky · lead = left + green · teammate = left + violet */
    .bubble.you { align-self:flex-end; background:rgba(56,189,248,.10); border-color:rgba(56,189,248,.35); }
    .bubble.you .nm { color:var(--human); } .bubble.you .pill { color:var(--human); }
    .bubble.lead { align-self:flex-start; } .bubble.lead .nm { color:var(--lead); } .bubble.lead .pill { color:var(--lead); }
    .bubble.teammate { align-self:flex-start; border-color:rgba(192,132,252,.35); }
    .bubble.teammate .nm { color:var(--teammate); } .bubble.teammate .pill { color:var(--teammate); }
    .thread-empty { margin:auto; max-width:420px; text-align:center; color:var(--dim); }
    .banner { margin:0 16px 8px; padding:8px 12px; border-radius:8px; background:var(--muted); color:var(--dim); font-size:13px; }
    .banner a { color:var(--lead); }

    .composer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--border); align-items:flex-end;
      box-shadow:0 -4px 12px rgba(0,0,0,.25); }
    .composer textarea { flex:1; resize:none; min-height:40px; max-height:140px; background:var(--muted);
      border:1px solid var(--border); border-radius:10px; padding:9px 12px; }
    .composer .send { background:var(--lead); color:#04120A; border:none; border-radius:10px; padding:9px 16px; font-weight:600; }
    .composer .send:disabled { opacity:.5; cursor:default; }
    .status { padding:0 16px 8px; color:var(--dim); font-size:12px; } .status.err { color:var(--danger); }

    /* kobo-390: @-autocomplete picker */
    .picker { position:absolute; bottom:64px; left:16px; right:16px; max-height:220px; overflow:auto;
      background:var(--panel,#151515); border:1px solid var(--border); border-radius:10px; box-shadow:0 -4px 16px rgba(0,0,0,.35); z-index:5; }
    .picker-group { padding:6px 10px 2px; font-size:11px; text-transform:uppercase; color:var(--dim); }
    .picker-item { padding:7px 12px; cursor:pointer; font-size:14px; display:flex; justify-content:space-between; gap:8px; }
    .picker-item:hover, .picker-item.sel { background:var(--muted); }
    .picker-item .hint { color:var(--dim); font-size:11px; }

    /* mobile single-pane slide */
    @media (max-width:768px) {
      .app { grid-template-columns:1fr; }
      .chat { display:none; }
      .app.showchat .topics { display:none; }
      .app.showchat .chat { display:flex; }
      .chat-header .back { display:inline; }
      .bubble { max-width:88%; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="brand">◆ maw</span>
    <select id="company" aria-label="company"></select>
    <span class="leadlbl">lead: <b id="leadName">—</b></span>
    <h1>Brainstorm Rooms</h1>
    <button id="newTopic" class="primary" type="button">+ New topic</button>
  </div>
  <div class="app" id="app">
    <aside class="topics">
      <h2 id="topicsHead">Topics</h2>
      <button id="roomFilterToggle" type="button"></button>
      <div id="roomlist"><div class="list-empty">loading…</div></div>
      <div id="mergebar" style="display:none; padding:8px 12px; border-top:1px solid var(--border);">
        <button id="mergeConfirm" class="act accent" type="button">confirm merge into this topic</button>
        <button id="mergeCancel" class="act" type="button">cancel</button>
      </div>
    </aside>
    <section class="chat" id="chat">
      <div class="chat-header">
        <button id="back" class="back" type="button" aria-label="back to topics">‹</button>
        <div>
          <div class="htopic" id="hTopic"># —</div>
          <div class="hsub" id="hSub"></div>
        </div>
        <span class="spacer"></span>
        <button id="inviteBtn" class="act" type="button">+ teammate</button>
        <button id="mergeBtn" class="act" type="button">merge</button>
        <button id="closeBtn" class="act" type="button">✕ close</button>
        <button id="distillBtn" class="act accent" type="button">distill ▸</button>
      </div>
      <div id="banner" class="banner" style="display:none;"></div>
      <div id="activity"></div>
      <div id="thread" aria-live="polite"><div class="thread-empty">เลือกหัวข้อ หรือเปิดใหม่เพื่อปรึกษา lead.</div></div>
      <div id="status" class="status"></div>
      <div id="picker" class="picker" style="display:none;"></div>
      <div class="composer">
        <textarea id="text" rows="1" placeholder="type to lead… (@ to tag)" aria-label="message"></textarea>
        <button id="send" class="send" type="button">send ▸</button>
      </div>
    </section>
  </div>
  <!-- kobo-422: click-to-zoom modal for mermaid thumbnails — one shared instance,
       content populated/cleared via cloneNode/replaceChildren (never innerHTML). -->
  <div id="mermaidModal" class="mmd-modal" style="display:none;" role="dialog" aria-modal="true" aria-label="diagram">
    <div class="mmd-modal-backdrop"></div>
    <div class="mmd-modal-body">
      <button id="mmdModalClose" class="mmd-modal-close" type="button" aria-label="close">✕</button>
      <div id="mmdModalContent"></div>
    </div>
  </div>
<script>
const $ = (id) => document.getElementById(id);
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function setStatus(msg, err) { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); }

// ── state ────────────────────────────────────────────────────────────────
const q = new URLSearchParams(location.search);
let company = q.get('company') || '';
let roomId = q.get('room') || '';
let lead = '';
let rooms = [];
let mergeMode = false;
let showClosed = false; // kobo-438: closed/merged rooms hide by default
let roomStatus = 'open';
let oracles = []; // kobo-390: company roster for the @-picker
let participants = []; // kobo-390: current room's explicit invite list
let scrolledToHash = null; // kobo-415: only auto-scroll to a #msg-N target once per hash, not every 2.5s poll
// kobo-486: (room, message count, last seq) we last actually rebuilt the
// thread DOM for — see the dirty-check in loadThread below.
let lastThreadRenderKey = null;

function syncUrl() {
  const u = new URL(location.href);
  u.searchParams.set('company', company);
  if (roomId) u.searchParams.set('room', roomId); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}

async function getJson(url) { const r = await fetch(url, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || (url + ' failed'));
  return j;
}

// kobo-397 — reuses the EXISTING POST /api/upload (upload.ts) as-is, multipart
// 'file' field. On a non-2xx, turns the server's already-detailed error into an
// ACTIONABLE message (real size/type + a concrete next step), not a dead end.
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'image');
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) {
    const msg = j.error || (res.status + ' upload failed');
    if (res.status === 413) throw new Error(msg + ' — try cropping or resizing the image first.');
    if (res.status === 415) throw new Error("can't upload this file type — " + msg);
    throw new Error(msg);
  }
  return j; // { ok, id, url, path, name, size, mime }
}

// ── company + room list (scoped, server-enforced) ──────────────────────────
async function loadRooms() {
  const { body } = await getJson('/api/rooms' + (company ? '?company=' + encodeURIComponent(company) : ''));
  if (!body || !body.ok) { setStatus('could not load rooms', true); return; }
  company = body.company || company;
  lead = body.lead || '';
  rooms = Array.isArray(body.rooms) ? body.rooms : [];
  oracles = Array.isArray(body.oracles) ? body.oracles : [];
  renderCompanies(body.companies || []);
  $('leadName').textContent = lead || '—';
  renderRoomList();
  syncUrl();
}

function renderCompanies(list) {
  const sel = $('company');
  if (sel.dataset.filled === '1' && sel.value === company) { /* keep */ }
  sel.replaceChildren();
  for (const c of list) { const o = el('option', null, c); o.value = c; if (c === company) o.selected = true; sel.appendChild(o); }
  sel.dataset.filled = '1';
}

function statusClass(s) { return s === 'open' ? 'st-open' : (s === 'merged' ? 'st-merged' : 'st-closed'); }
function statusDot(s) { return s === 'open' ? '●' : (s === 'merged' ? '○' : '◐'); }

function renderRoomList() {
  const box = $('roomlist');
  // kobo-438: "inactive" = closed OR merged (Tony: a merged room is a
  // signpost to another room, not a place to talk) — hidden by default,
  // reversing kobo-379's old "show it, just gray it out". The toggle button
  // is the only way back to them, so its count must match exactly what
  // showClosed=true reveals (never count just closed while hiding both).
  const hidden = rooms.filter((r) => r.status !== 'open');
  const visible = showClosed ? rooms : rooms.filter((r) => r.status === 'open');
  const toggle = $('roomFilterToggle');
  toggle.textContent = (showClosed ? 'ซ่อน' : '') + 'ห้องที่ปิด/รวมแล้ว (' + hidden.length + ')';
  toggle.classList.toggle('active', showClosed);
  box.replaceChildren();
  if (!rooms.length) {
    const e = el('div', 'list-empty');
    e.appendChild(el('div', null, 'ยังไม่มีห้องใน ' + company + '. เปิดหัวข้อแรกเพื่อปรึกษา ' + (lead || 'lead') + '.'));
    const b = el('button', 'primary', '+ New topic'); b.type = 'button'; b.addEventListener('click', newTopic);
    e.appendChild(b);
    box.appendChild(e);
    return;
  }
  if (!visible.length) {
    const e = el('div', 'list-empty');
    e.appendChild(el('div', null, 'ห้องที่เปิดอยู่ไม่มี — กดปุ่มด้านบนเพื่อดูห้องที่ปิด/รวมแล้ว'));
    box.appendChild(e);
    return;
  }
  for (const r of visible) {
    const row = el('div', 'roomrow ' + statusClass(r.status) + (r.id === roomId ? ' active' : ''));
    row.tabIndex = 0;
    if (mergeMode && r.id !== roomId && r.status !== 'merged') {
      const cb = el('input'); cb.type = 'checkbox'; cb.className = 'msrc'; cb.value = r.id;
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      row.appendChild(cb);
    }
    row.appendChild(el('span', 'dot', statusDot(r.status)));
    row.appendChild(el('span', 'rtopic', r.topic || r.id));
    const open = () => selectRoom(r.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    box.appendChild(row);
  }
}

function selectRoom(id) {
  roomId = id;
  closePicker();
  $('app').classList.add('showchat'); // mobile: slide to chat
  renderRoomList();
  syncUrl();
  loadThread();
}

// ── thread + attribution (you / lead / teammate — pill + alignment + colour) ─
// kobo-396 — shared markdown renderer (src/views/md.ts), injected verbatim via
// toString() — same single-source pattern company.ts uses for stateBadge etc.
// This view's client script stays backtick-free in its OWN source (see file
// header); mdToHtml/inlineMd use backticks internally (code-span syntax), so
// they can only be spliced in as the RUNTIME string toString() returns, never
// pasted as literal source here.
${escapeHtml.toString()}
${inlineMd.toString()}
${mdToHtml.toString()}
// kobo-397 — same toString() embed for the maw:// image-ref renderer (md.ts).
const NOTE_IMG_EXT = ${NOTE_IMG_EXT};
${renderNoteBody.toString()}

function roleOf(from) {
  if (from === 'web' || from === 'you') return 'you';
  if (lead && from === lead) return 'lead';
  return 'teammate';
}
function pillText(role) { return role === 'you' ? 'you' : (role === 'lead' ? 'lead' : 'teammate'); }
function fmtTs(ts) { if (!ts) return ''; const d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

// kobo-380 — auto-linkify URLs in message bodies. XSS-safe by construction: text is
// split into plain segments (appended as text nodes, never raw markup) and URL segments
// (appended as <a> elements built with createElement + textContent, href only set after
// isSafeUrl allowlists the protocol). A javascript:/data:/vbscript: URL — or any raw
// script/HTML in the message — is never parsed as markup, so it renders as inert text.
const URL_RE = /https?:\\/\\/[^\\s<>"']+/g;
function isSafeUrl(url) {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}
function linkify(container, text) {
  URL_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    let url = m[0], trail = '';
    while (url && /[),.;:!?\\]'"]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    if (url && isSafeUrl(url)) {
      const a = document.createElement('a');
      a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(url));
    }
    if (trail) container.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

// kobo-396 — bare-URL autolink (kobo-380) is NOT part of mdToHtml (shared with
// company.ts's board notes, which never had bare-URL autolink — adding it to the
// shared inlineMd would change board render, breaking the "byte-identical" board
// invariant). Kept as a ROOM-ONLY post-pass over mdToHtml's rendered DOM instead:
// walk text nodes, skip ones already inside <a>/<code>/<pre> (don't double-link
// or touch code), and re-split each via the existing XSS-safe linkify().
function linkifyDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && (p.closest('a') || p.closest('code') || p.closest('pre'))) continue;
    nodes.push(n);
  }
  for (const textNode of nodes) {
    const frag = document.createDocumentFragment();
    linkify(frag, textNode.data);
    textNode.replaceWith(frag);
  }
}

// kobo-527 — "kobo-N" card refs in message text become a clickable chip that
// opens the card in the SAME #mermaidModal instance the diagram zoom uses (no
// second modal). Run AFTER linkifyDom: URL text is already wrapped in <a> by
// then, so this pass's own closest('a') skip keeps a card number pasted
// INSIDE a URL (the main over-match risk — this room pastes card numbers in
// URLs and code blocks all day) from becoming a second, nested chip.
// kobo-513 lesson: match by SHAPE (any word-ish-token + '-' + digits), not by
// hardcoding this company's own "kobo-" prefix — the company check happens
// at match time against the live company var, not baked into the regex, so
// a differently-prefixed id from another company never turns into a chip
// (kobo-527 Q3: same-company only, narrow first).
const CARD_REF_RE = /\\b([a-zA-Z][a-zA-Z0-9]*)-(\\d+)\\b/g;
function cardLinkify(container, text) {
  CARD_REF_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = CARD_REF_RE.exec(text))) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const id = m[0], prefix = m[1];
    if (company && prefix.toLowerCase() === company.toLowerCase()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'card-ref-chip mono';
      chip.textContent = id;
      chip.setAttribute('data-card-id', id);
      container.appendChild(chip);
    } else {
      container.appendChild(document.createTextNode(id));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
function cardLinkifyDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && (p.closest('a') || p.closest('code') || p.closest('pre'))) continue;
    nodes.push(n);
  }
  for (const textNode of nodes) {
    const frag = document.createDocumentFragment();
    cardLinkify(frag, textNode.data);
    textNode.replaceWith(frag);
  }
}
// kobo-538: which card-ref modal fetch is currently in flight, if any. Two
// problems this fixes together: (1) the modal used to show NOTHING until the
// fetch resolved — on a slow server (kobo-526 measured ~1.1s) a reader sees no
// feedback and clicks again, firing a second identical fetch; (2) that repeat
// fetch used to re-download the card's FULL notes/comments (kobo-446 has 434
// notes → 1.5MB) even though this modal only ever renders id/title/state/
// assignee/body — ?notes=0 (core/tasks/route.ts) drops them server-side instead
// of fetching-then-discarding client-side.
// kobo-538 round 2 — the in-flight marker is keyed on a per-REQUEST token, not
// on the card id alone. Keying it on the id made closing the modal mid-load
// leave the marker set, so the next click on that same card hit the repeat-click
// no-op above and did nothing — a dead click, in exactly the ~1.1s window this
// card exists to fix. It did not always clear itself either: getJson has no
// timeout and no AbortSignal, so a request that never settles never reaches the
// finally block, and that card stayed unopenable until a page reload.
// Clearing the marker on close is necessary but not sufficient on its own: the
// abandoned request is still in flight, and its finally would then clear the
// marker belonging to the NEW request, reopening the double-fetch hole for the
// click after that. The token makes each request only ever clear its own marker.
let cardModalSeq = 0;
let cardModalInFlight = null; // { id, token } while a card fetch is outstanding
async function openCardModal(id) {
  if (cardModalInFlight && cardModalInFlight.id === id) return; // already loading this exact card — a repeat click is a no-op, not a second fetch
  const token = ++cardModalSeq;
  cardModalInFlight = { id, token };
  const box = el('div', 'card-ref-modal');
  box.appendChild(el('div', 'card-ref-modal-loading', 'loading ' + id + '…'));
  openMermaidModal(box); // show the modal (with the loading state) BEFORE the fetch, not after
  try {
    const { body } = await getJson('/api/tasks/detail?company=' + encodeURIComponent(company) + '&id=' + encodeURIComponent(id) + '&notes=0');
    // Superseded by a newer open, or the modal was closed — drop this response.
    // HONEST NOTE (kobo-538 round 2): removing this line reddens NOTHING, and
    // that is not a gap in the tests — a superseded response CANNOT REACH THE
    // SCREEN by construction. Every openCardModal call builds its OWN box above
    // and hands it to openMermaidModal, which replaceChildren()s it into the
    // single content slot, so a superseded call's box is already detached.
    // That is inferred from the control flow (an early return before ANY DOM
    // write, no branches to miss), not measured — nothing to dynamically test.
    //
    // CORRECTED (kobo-588, superseding an earlier claim in this comment that
    // removing this line would leak an image request): stitch measured it
    // (kobo-585) — a detached note-img (loading=lazy, md.ts) did NOT issue
    // its /api/files/... request in EITHER of 2 rounds, with a positive
    // control (an attached image DID request) passing every round. Measured
    // on Chrome 150.0.7871.187, headed, no throttling, via a standalone
    // harness (not the live company board) — bounded to that config.
    // loading=lazy is a browser HINT, not a contract, so this is NOT "a
    // detached lazy image never fetches" as a general rule — a different
    // browser/version/network condition could measure differently. Read it
    // as "measured, not found on this config," never as "impossible."
    // (patchwork reviewer registered a falsifiable prediction BEFORE the
    // measurement — "if no request shows up, I'm clearly wrong" — which is
    // what makes this result decisive rather than just another guess landing
    // where the first one did. kobo-585, credit: stitch.)
    //
    // This guard is kept anyway, for a reason that doesn't depend on the
    // measurement above: it's a structural guard for the day someone makes
    // the modal reuse one box instead of building a fresh one per open — at
    // that point a superseded response CAN reach the screen, and this line
    // is what stops it. Not a tested guarantee today; a guarantee for a
    // shape the code doesn't have yet.
    if (!cardModalInFlight || cardModalInFlight.token !== token) return;
    box.replaceChildren();
    const t = body && body.ok ? body.task : null;
    if (!t) {
      box.appendChild(el('div', 'card-ref-modal-err', 'card not found: ' + id));
    } else {
      box.appendChild(el('div', 'card-ref-modal-title', t.id + ' · ' + (t.title || '')));
      box.appendChild(el('div', 'card-ref-modal-meta', 'state: ' + t.state + (t.assignee ? ' · assignee: ' + t.assignee : '')));
      if (t.body) {
        const bodyDiv = el('div', 'card-ref-modal-body body md');
        bodyDiv.innerHTML = renderNoteBody(t.body); // same escape-first renderer as message bodies — same XSS guarantee
        box.appendChild(bodyDiv);
      }
    }
  } finally {
    if (cardModalInFlight && cardModalInFlight.token === token) cardModalInFlight = null; // only ever clear OUR OWN marker — never a newer request's
  }
}

// kobo-398 — mermaid, lazy-loaded ONLY when a mermaid-fenced code block is
// actually present (LAZY-BY-ABSENCE: a thread with no diagram never touches the
// network for this asset). Same-origin asset (/assets/vendor/mermaid.js, new
// route — no CDN). Load-once: the Promise is cached so re-polls never re-fetch.
// securityLevel:'strict' disables htmlLabels (labels render as SVG <text>, no
// foreignObject) — the load-bearing guard, layered on top of mdToHtml's
// escape-first source (the div's text content is ALREADY html-escaped).
const MERMAID_ASSET_URL = '/assets/vendor/mermaid.js?v=11.16.0'; // bump alongside package.json's exact pin
// kobo-422: mermaid's default palette (purple/pink) doesn't match the room's
// dark theme — theme:'base' + themeVariables lets us paint it with the SAME
// :root custom properties this page already uses. mermaidThemeId is a plain
// "let" (not const, and no backticks — this is ONE template literal, see file
// header) purely so a test harness can swap it to prove the cache key
// (below) actually invalidates on theme change — it is NEVER reassigned by
// shipped code (no runtime theme switcher exists yet).
let mermaidThemeId = 'kobo-dark-v1'; // bump this whenever MERMAID_THEME_VARIABLES changes — invalidates every cached SVG for free
const MERMAID_THEME_VARIABLES = {
  darkMode: true,
  background: '#0F172A', // --bg
  mainBkg: '#1E293B', // --surface — node fill
  primaryColor: '#1E293B', // --surface
  primaryTextColor: '#F8FAFC', // --fg
  primaryBorderColor: '#475569', // --border
  secondaryColor: '#334155', // --surface-2
  tertiaryColor: '#272F42', // --muted
  lineColor: '#94A3B8', // --dim — edges
  textColor: '#F8FAFC', // --fg
  nodeBorder: '#475569', // --border
  clusterBkg: '#272F42', // --muted
  clusterBorder: '#475569', // --border
  edgeLabelBackground: '#272F42', // --muted
  errorBkgColor: '#EF4444', // --danger
  errorTextColor: '#F8FAFC', // --fg
};
let mermaidLoadPromise = null;
function loadMermaid() {
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MERMAID_ASSET_URL;
      s.onload = () => {
        try {
          window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'base', themeVariables: MERMAID_THEME_VARIABLES });
          resolve(window.mermaid);
        }
        catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('failed to load mermaid asset'));
      document.head.appendChild(s);
    });
  }
  return mermaidLoadPromise;
}
let mermaidBlockSeq = 0;
// kobo-398 review fix (M1): loadThread rebuilds the WHOLE thread DOM every 2.5s
// poll (fresh .mermaid-src nodes each time), so caching only the asset-load
// Promise still re-parsed+re-laid-out every unchanged diagram every poll. Cache
// the rendered SVG by source text instead — a poll whose diagrams are unchanged
// never touches mermaid.render at all.
// kobo-422: key includes the theme id too — switching theme must invalidate
// every cached SVG (a diagram rendered under the OLD palette must never be
// served as-is once the theme changes), not just the source text.
const mermaidSvgCache = new Map();
// U+0001 between fields is a real separator (never appears in a mermaid
// source string or in JSON.stringify output) — without one, theme "a" + src
// "bc" would collide in the map with theme "ab" + src "c".
// kobo-426: mermaidThemeId alone relied on a human remembering to bump it
// whenever MERMAID_THEME_VARIABLES changed (the comment above it said so,
// nothing enforced it). Folding a stringified copy of the variables directly
// into the key makes invalidation mechanical: change any theme value, the
// key changes, no bump required. mermaidThemeId itself stays too — a test
// harness still swaps it directly to prove that path independently.
function mermaidCacheKey(src) { return mermaidThemeId + '' + JSON.stringify(MERMAID_THEME_VARIABLES) + '' + src; }
async function renderMermaidBlocks(root) {
  const blocks = root.querySelectorAll('.mermaid-src');
  if (!blocks.length) return; // nothing to render — never load the asset (lazy-by-absence)
  // pending[i].svg stays undefined until we have SOMETHING to paint (cache hit
  // or a fresh render) — the actual write happens in ONE place below, so a
  // cache hit and a freshly-rendered diagram are the same sink, not two.
  // querySelectorAll returns a NodeList — no .map (same idiom as the existing
  // Array.from(...).map at line ~675 for .msrc:checked).
  const pending = Array.from(blocks).map((block) => ({ block, src: block.textContent || '', svg: undefined }));
  const misses = pending.filter((p) => { const c = mermaidSvgCache.get(mermaidCacheKey(p.src)); if (c !== undefined) p.svg = c; return c === undefined; });
  if (misses.length) {
    try {
      const mermaid = await loadMermaid();
      for (const p of misses) {
        try {
          // per-block isolation: ONE malformed diagram's throw is caught HERE,
          // inside the loop — it can never abort the rest of the thread's blocks.
          const { svg } = await mermaid.render('mmd-' + (mermaidBlockSeq++), p.src);
          mermaidSvgCache.set(mermaidCacheKey(p.src), svg);
          p.svg = svg;
        } catch (e) { /* leave the escaped source text in place — already the fallback */ }
      }
    } catch { /* asset load failed — source text stays as the fallback for all misses */ }
  }
  for (const p of pending) {
    if (p.svg === undefined) continue; // load/render failed for this one — source text is already the fallback
    // the NEXT 2.5s poll can rebuild the thread (loadThread's replaceChildren)
    // before an in-flight render settles — writing into a detached node is a
    // silent no-op for the user. Drop the write; the cache still pays off next poll.
    if (!p.block.isConnected) continue;
    // per-block isolation applies here too — a cache-hit write is still one
    // block among siblings; one failing write must never skip the rest.
    try {
      p.block.innerHTML = p.svg;
      // kobo-422: only a SUCCESSFULLY rendered block becomes a clickable
      // thumbnail — the escaped-source fallback (render/load failed) never gets
      // this class, so there's nothing to zoom into.
      p.block.classList.add('mermaid-thumb');
    } catch (e) { /* leave the fallback source text in place */ }
  }
}

async function loadThread() {
  if (!company || !roomId) return;
  const { status, body } = await getJson('/api/room/thread?company=' + encodeURIComponent(company) + '&room=' + encodeURIComponent(roomId));
  const thread = $('thread');
  if (status === 404 || !body.ok || !body.room) { thread.replaceChildren(el('div', 'thread-empty', 'ห้องนี้ยังไม่ถูกเปิด')); return; }
  const room = body.room;
  roomStatus = room.status || 'open';
  participants = Array.isArray(room.participants) ? room.participants : [];
  updateRoomControls();
  $('hTopic').textContent = '# ' + (room.topic || room.id);
  const inRoom = new Set(room.messages.map((m) => m.from).filter((f) => f && roleOf(f) !== 'you'));
  $('hSub').textContent = 'with ' + (lead || '—') + ' (lead) · ' + inRoom.size + ' in room';
  const banner = $('banner');
  if (room.cardId) { banner.style.display = ''; banner.replaceChildren(document.createTextNode('กลั่นเป็น card '), Object.assign(el('a', null, room.cardId), { href: '/company?company=' + encodeURIComponent(company) })); }
  else if (room.status !== 'open') { banner.style.display = ''; banner.textContent = 'ห้องนี้ ' + room.status + ' — thread read-only'; }
  else banner.style.display = 'none';

  const msgs = room.messages.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // kobo-486: loadThread rebuilt the whole thread DOM every 2.5s poll even
  // when nothing changed (ForcedReflow/DOMSize hot path — ~535 elements per
  // rebuild on a typical room). kobo-415's per-message seq is already a
  // stable, monotonic counter; (room, message count, last seq) tells us
  // whether a rebuild could produce anything different from what's already
  // on screen. Equal to what we last rendered ⇒ skip the rebuild below
  // (metadata above — topic/banner/participants — already refreshed
  // regardless; loadActivity() below still always runs, since presence can
  // change with zero new messages). Different (including first render, or a
  // room switch, since roomKey is part of the comparison) ⇒ always rebuild —
  // per this card's AC, a false "unchanged" here would hide a real message,
  // which is worse than an unnecessary rebuild, so this must err toward
  // rebuilding whenever it isn't certain nothing changed.
  const lastMsg = msgs[msgs.length - 1];
  // kobo-472 scar: the quotes below aren't empty — each holds a real U+0001
  // separator (invisible in most editors/terminals). Without one, company
  // "a" + room "bc" and company "ab" + room "c" collide into the same key.
  const threadRenderKey = company + '' + roomId + '' + msgs.length + '' + (lastMsg ? lastMsg.seq : '');
  if (threadRenderKey === lastThreadRenderKey) {
    loadActivity();
    return;
  }
  lastThreadRenderKey = threadRenderKey;
  // kobo-293: stick-to-bottom only when the user is already near the bottom, so
  // scrolling up to read history isn't yanked back down every 2.5s poll. Capture
  // BEFORE the rebuild while the old scroll metrics are still valid. First render
  // (scrollTop 0, no scrollbar) reads as near-bottom → opens at newest.
  const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  thread.replaceChildren();
  if (!msgs.length) { thread.appendChild(el('div', 'thread-empty', (lead || 'lead') + ' พร้อมช่วย ground ปัญหา. พิมพ์ข้อความแรกด้านล่าง.')); loadActivity(); return; }
  for (const m of msgs) {
    const role = roleOf(m.from);
    const b = el('div', 'bubble ' + role);
    b.id = 'msg-' + m.seq; // kobo-415: stable anchor id; see the hash-scroll block below loadThread's render loop for the actual #N navigation
    const head = el('div', 'head');
    head.appendChild(el('span', 'nm', m.from || '?'));
    head.appendChild(el('span', 'pill', pillText(role)));
    head.appendChild(el('span', 'seqno mono', '#' + m.seq));
    head.appendChild(el('span', 'ts mono', fmtTs(m.ts)));
    b.appendChild(head);
    if (role === 'teammate') b.appendChild(el('div', 'tag', '🔎 pulled in'));
    // kobo-396/397 — markdown render + maw:// image-ref swap (shared renderNoteBody,
    // escape-first = XSS-safe: src is always OUR OWN /api/files/<matched-filename>
    // string, never attacker-controlled) + the room-only bare-URL post-pass
    // (kobo-380 preserved, see linkifyDom).
    const bodyEl = el('div', 'body md');
    bodyEl.innerHTML = renderNoteBody(m.text || '');
    linkifyDom(bodyEl);
    cardLinkifyDom(bodyEl); // kobo-527: card-ref chips, after URL linkify so a card # pasted inside a link stays inert
    b.appendChild(bodyEl);
    thread.appendChild(b);
  }
  if (stick) thread.scrollTop = thread.scrollHeight;
  // kobo-415: thread.replaceChildren() above just destroyed and rebuilt every #msg-N node,
  // so a hash present at page-load (or a hand-typed link) resolves against nodes that did
  // not exist yet — the browser's native same-page jump silently no-ops. Redo it ourselves
  // now that the target exists. Scroll once per hash value, not on every 2.5s poll, so it
  // doesn't fight a reader who has since scrolled elsewhere in the thread.
  if (location.hash && location.hash !== scrolledToHash) {
    const anchorTarget = document.getElementById(location.hash.slice(1));
    if (anchorTarget) { anchorTarget.scrollIntoView({ block: 'center' }); scrolledToHash = location.hash; }
  }
  renderMermaidBlocks(thread); // kobo-398 — async, fire-and-forget; leaves source text until it resolves
  loadActivity();
}

// ── activity strip (who's here — reuse kobo-242 projection) ─────────────────
async function loadActivity() {
  if (!company || !roomId) { $('activity').replaceChildren(); return; }
  const { body } = await getJson('/api/room/activity?company=' + encodeURIComponent(company) + '&room=' + encodeURIComponent(roomId));
  const parts = (body && body.ok && Array.isArray(body.participants)) ? body.participants : [];
  const box = $('activity'); box.replaceChildren();
  for (const p of parts) {
    const w = el('span', 'act-who');
    w.appendChild(el('span', 'dot ' + (p.busy ? 'on' : 'off'), p.busy ? '●' : '○'));
    w.appendChild(el('span', 'nm', ' ' + p.oracle + ' '));
    w.appendChild(el('span', null, p.activity ? '· ' + p.activity : (p.busy ? '· active' : '· idle')));
    box.appendChild(w);
  }
}

// ── compose / send (Enter=send, Shift+Enter=newline; default target = lead) ──
function autogrow() { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }
async function send() {
  const text = $('text').value.trim();
  if (!company || !roomId) { setStatus('เลือกหรือเปิดหัวข้อก่อน', true); return; }
  if (!lead) { setStatus('company นี้ไม่มี lead', true); return; }
  if (!text) return;
  $('send').disabled = true;
  try {
    const res = await post('/api/room/send', { room: roomId, to: lead, text: text, from: 'web' }); // web turn tagged human (kobo-248)
    $('text').value = ''; autogrow();
    // kobo-506: the turn is saved either way (persist is decoupled from the nudge,
    // kobo-249) — but a failed nudge means the lead was never told, so say so distinctly
    // from the normal "waiting" status instead of silently claiming success.
    if (res && res.notified === false) {
      setStatus('sent, saved — but the lead was NOT notified (' + (res.notifyError || 'nudge failed') + ') — they may not see this until they check the room', true);
    } else {
      setStatus('sent to ' + lead + ' — waiting…');
    }
    setTimeout(loadThread, 500);
  } catch (err) { setStatus('ส่งไม่สำเร็จ — retry: ' + (err && err.message ? err.message : err), true); }
  finally { $('send').disabled = false; }
}

// kobo-397 — paste (Ctrl+V) or drag-drop an image into the compose box → upload
// via the EXISTING /api/upload → insert the SAME maw://<node>/<file> ref format
// notes use (no invented scheme) → renderNoteBody (above) swaps it for a real
// <img> once sent. 'local' = this codebase's existing self/same-node alias
// (routing.ts) — correct for the MVP local-node scope (kobo-116), same as the
// render side never resolving the node segment for local display.
function insertTextAtCursor(t, text) {
  const start = t.selectionStart, end = t.selectionEnd;
  const before = t.value.slice(0, start), after = t.value.slice(end);
  t.value = before + text + after;
  const pos = (before + text).length;
  t.setSelectionRange(pos, pos);
  autogrow();
}
async function handleImageFile(file) {
  setStatus('uploading ' + (file.name || 'image') + '…');
  try {
    const j = await uploadImage(file);
    const filename = (j.url || '').split('/').pop(); // the servable /api/files/<filename> — see upload.ts
    insertTextAtCursor($('text'), 'maw://local/' + filename + ' ');
    setStatus('image attached — send to share');
  } catch (err) {
    setStatus('upload failed: ' + (err && err.message ? err.message : err), true);
  }
}
function isImageFile(file) { return !!file && !!file.type && file.type.indexOf('image/') === 0; }
function onComposePaste(ev) {
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (const item of items) {
    if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (file) handleImageFile(file);
      return;
    }
  }
}
function onComposeDrop(ev) {
  ev.preventDefault();
  const files = (ev.dataTransfer && ev.dataTransfer.files) || [];
  for (const file of files) if (isImageFile(file)) handleImageFile(file);
}

// ── @-tag picker (kobo-390): grouped "in this room" vs "invite"; picking an
// invite entry fires the EXISTING /api/room/invite (auto-invite), then inserts the
// tag — narrow-scope routing (server) + broad-roster picker (client), bridged by invite.
let pickerItems = [];
let pickerRowEls = []; // kobo-392: DOM rows parallel to pickerItems, for keyboard highlight
let pickerActiveIndex = 0; // kobo-392: the row Tab/Enter select (mouseover keeps this in sync)
function tagQueryAt(value, caret) {
  const head = value.slice(0, caret);
  const m = head.match(/(?:^|\s)@([a-z0-9][a-z0-9_.-]*)$/i);
  return m ? { start: caret - m[1].length - 1, query: m[1].toLowerCase() } : null;
}
function closePicker() { $('picker').style.display = 'none'; $('picker').replaceChildren(); pickerItems = []; pickerRowEls = []; pickerActiveIndex = 0; }
function highlightActive() {
  for (let i = 0; i < pickerRowEls.length; i++) pickerRowEls[i].classList.toggle('sel', i === pickerActiveIndex);
}
function setActiveIndex(i) { pickerActiveIndex = i; highlightActive(); }
function pickerRow(oracle, needsInvite, index) {
  const row = el('div', 'picker-item');
  row.appendChild(el('span', null, '@' + oracle));
  if (needsInvite) row.appendChild(el('span', 'hint', 'invite'));
  row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickTag(oracle, needsInvite); });
  row.addEventListener('mouseover', () => setActiveIndex(index)); // hover + keyboard agree on one index
  return row;
}
function renderPicker(query) {
  const inRoomSet = new Set(participants);
  const matches = oracles.filter((o) => o.toLowerCase().startsWith(query));
  const inRoom = matches.filter((o) => inRoomSet.has(o));
  const invite = matches.filter((o) => !inRoomSet.has(o));
  pickerItems = inRoom.concat(invite);
  const box = $('picker');
  box.replaceChildren();
  pickerRowEls = [];
  pickerActiveIndex = 0;
  if (!pickerItems.length) { closePicker(); return; }
  if (inRoom.length) box.appendChild(el('div', 'picker-group', 'in this room'));
  for (const o of inRoom) { const row = pickerRow(o, false, pickerRowEls.length); pickerRowEls.push(row); box.appendChild(row); }
  if (invite.length) box.appendChild(el('div', 'picker-group', 'invite to room'));
  for (const o of invite) { const row = pickerRow(o, true, pickerRowEls.length); pickerRowEls.push(row); box.appendChild(row); }
  box.style.display = '';
  highlightActive();
}
async function pickTag(oracle, needsInvite) {
  const t = $('text');
  const at = tagQueryAt(t.value, t.selectionStart);
  closePicker();
  if (needsInvite) {
    try { await post('/api/room/invite', { company, room: roomId, oracle }); }
    catch (err) { setStatus('invite failed: ' + (err && err.message ? err.message : err), true); return; }
    participants = participants.concat(oracle);
  }
  if (at) {
    const before = t.value.slice(0, at.start);
    const after = t.value.slice(t.selectionStart);
    t.value = before + '@' + oracle + ' ' + after;
    const pos = (before + '@' + oracle + ' ').length;
    t.setSelectionRange(pos, pos);
  }
  t.focus(); autogrow();
}
function onComposeInput() {
  autogrow();
  const t = $('text');
  const at = tagQueryAt(t.value, t.selectionStart);
  if (at) renderPicker(at.query); else closePicker();
}

// ── new topic / distill / merge (reuse the engine endpoints) ────────────────
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('room-' + Date.now()); }
async function newTopic() {
  const topic = prompt('New topic (what to brainstorm with ' + (lead || 'lead') + '):');
  if (!topic || !topic.trim()) return;
  const id = slug(topic.trim());
  try { await post('/api/room/open', { company, room: id, topic: topic.trim() }); await loadRooms(); selectRoom(id); }
  catch (err) { setStatus('เปิดหัวข้อไม่สำเร็จ: ' + (err && err.message ? err.message : err), true); }
}
async function distill() {
  if (!roomId) { setStatus('เลือกหัวข้อก่อน distill', true); return; }
  const title = prompt('Distill this room into a card — outcome (problem + approach):');
  if (!title || !title.trim()) return;
  try {
    const j = await post('/api/room/distill', { company, room: roomId, title: title.trim() });
    const id = j.card && j.card.id ? j.card.id : '?';
    setStatus('distilled → card ' + id + (j.deduped ? ' (already linked)' : ''));
    loadThread();
  } catch (err) { setStatus('distill failed: ' + (err && err.message ? err.message : err), true); }
}
// kobo-260 — pull a teammate into the room: records them + sends one plain notify hey.
async function invite() {
  if (!roomId) { setStatus('เลือกหัวข้อก่อน invite', true); return; }
  const oracle = prompt('Pull a teammate into this room (oracle name, e.g. thawanban):');
  if (!oracle || !oracle.trim()) return;
  try {
    await post('/api/room/invite', { company, room: roomId, oracle: oracle.trim() });
    setStatus(oracle.trim() + ' pulled in — notified'); loadThread();
  } catch (err) { setStatus('invite failed: ' + (err && err.message ? err.message : err), true); }
}
// kobo-379 — close/reopen affordance: ✕ closes an open room (reject further replies,
// kobo-296 already enforces this server-side); an already-closed/merged room shows
// "↺ reopen" instead, which re-enables the composer.
function updateRoomControls() {
  const btn = $('closeBtn');
  const open = roomStatus === 'open';
  btn.textContent = open ? '✕ close' : '↺ reopen';
  $('text').disabled = !open;
  $('send').disabled = !open;
}
async function toggleRoomOpen() {
  if (!roomId) return;
  const wasOpen = roomStatus === 'open';
  try {
    await post(wasOpen ? '/api/room/close' : '/api/room/reopen', { company, room: roomId });
    setStatus(wasOpen ? 'ห้องถูกปิดแล้ว' : 'เปิดห้องอีกครั้งแล้ว');
    await loadRooms(); loadThread();
  } catch (err) { setStatus((wasOpen ? 'close' : 'reopen') + ' failed: ' + (err && err.message ? err.message : err), true); }
}
function enterMerge() {
  if (!roomId) { setStatus('เลือก target topic (ห้องปัจจุบัน) ก่อน merge', true); return; }
  mergeMode = true; $('mergebar').style.display = ''; $('topicsHead').textContent = 'Merge into: ' + roomId; renderRoomList();
}
function cancelMerge() { mergeMode = false; $('mergebar').style.display = 'none'; $('topicsHead').textContent = 'Topics'; renderRoomList(); }
async function confirmMerge() {
  const sources = Array.from(document.querySelectorAll('.msrc:checked')).map((c) => c.value);
  if (!sources.length) { setStatus('เลือกอย่างน้อย 1 ห้องเพื่อ fold เข้า ' + roomId, true); return; }
  if (!window.confirm('Merge ' + sources.length + ' room(s) into "' + roomId + '"? Sources are archived (kept, not deleted).')) return;
  try {
    await post('/api/room/merge', { company, target: roomId, sources: sources, confirm: true });
    setStatus('merged ' + sources.length + ' room(s) into "' + roomId + '"'); cancelMerge(); await loadRooms(); loadThread();
  } catch (err) { setStatus('merge failed: ' + (err && err.message ? err.message : err), true); }
}

// ── mermaid click-to-zoom modal (kobo-422) ──────────────────────────────────
// loadThread's replaceChildren() (2.5s poll) makes every diagram a NEW DOM node
// each round — a listener bound directly to a diagram would be lost every poll.
// Fix is event DELEGATION, not touching loadThread: bind ONE click listener to
// #thread (never itself replaced, only its children) below, in the wire block.
// Modal content is populated via cloneNode of the diagram's OWN already-rendered
// <svg> (the SAME element the thumbnail shows, never re-rendered) + replaceChildren
// — no innerHTML involved, so this adds no new innerHTML sink.
// kobo-426: aria-modal="true" on #mermaidModal (see the template above) is a
// promise to keyboard/screen-reader users that focus moves in and comes back
// — nothing here kept it before. Capture whatever had focus (the thumbnail
// that triggered this), move focus into the modal, and restore on close.
let mermaidModalReturnFocus = null;
function openMermaidModal(svgNode) {
  mermaidModalReturnFocus = document.activeElement;
  $('mmdModalContent').replaceChildren(svgNode);
  $('mermaidModal').style.display = '';
  $('mmdModalClose').focus();
}
function closeMermaidModal() {
  $('mermaidModal').style.display = 'none';
  $('mmdModalContent').replaceChildren();
  cardModalInFlight = null; // kobo-538: closing mid-load must not leave that card unopenable — see openCardModal
  if (mermaidModalReturnFocus && mermaidModalReturnFocus.focus) mermaidModalReturnFocus.focus();
  mermaidModalReturnFocus = null;
}
// kobo-426: mermaid.render's SVG carries an id (the 'mmd-N' passed in above)
// plus internal marker/gradient ids referenced via url(#...) or href="#...".
// cloneNode(true) copies those ids verbatim — while the modal is open, the
// SAME id exists twice in the live document (the thumbnail's original SVG,
// still in #thread, and this clone in the modal). Duplicate ids break
// getElementById/aria-* lookups and can misresolve url(#...) references to
// the wrong instance's defs. Rewrite every id in the CLONE to a fresh one
// before it's inserted, fixing up every attribute that pointed at the old id.
let mermaidCloneIdSeq = 0;
// kobo-513: the previous fixed attribute-name list (fill/stroke/marker-*/
// clip-path/mask/href) missed filter, inline style="...url(#x)...", and
// xlink:href — and even for names ALREADY on the list, a mutation test
// proved nothing was actually watching whether the list stayed complete
// (deleting 'href' from it left every test green). Matching by the VALUE'S
// SHAPE instead closes both gaps at once — url(#id) is unambiguous SVG
// reference syntax on ANY attribute (paint servers, filter, inline style,
// no name list to maintain or fall out of sync). A BARE #id value is
// ambiguous — href="#section-2" is a REAL hyperlink on an anchor element,
// not an id reference — so bare-hash rewriting is restricted to href/
// xlink:href AND excludes the anchor tag (kobo-513's main risk is
// over-matching a real link, not under-matching a reference).
const BARE_HASH_REF_ATTRS = new Set(['href', 'xlink:href']);
function dedupeSvgIds(svgNode) {
  const allEls = [svgNode, ...svgNode.querySelectorAll('*')];
  const idMap = new Map();
  for (const el of allEls) {
    const oldId = el.getAttribute('id');
    if (oldId == null) continue;
    const newId = oldId + '-clone' + (mermaidCloneIdSeq++);
    idMap.set(oldId, newId);
    el.setAttribute('id', newId);
  }
  if (!idMap.size) return svgNode;

  for (const el of allEls) {
    for (const attrName of el.getAttributeNames()) {
      const val = el.getAttribute(attrName);
      if (!val) continue;

      if (val.indexOf('url(#') !== -1) {
        const rewritten = val.replace(/url\\(#([^)]+)\\)/g, (whole, oldId) => {
          const newId = idMap.get(oldId);
          return newId ? 'url(#' + newId + ')' : whole;
        });
        if (rewritten !== val) { el.setAttribute(attrName, rewritten); continue; }
      }

      if (BARE_HASH_REF_ATTRS.has(attrName) && el.tagName !== 'a' && val.charAt(0) === '#') {
        const newId = idMap.get(val.slice(1));
        if (newId) el.setAttribute(attrName, '#' + newId);
      }
    }
  }
  return svgNode;
}
function onThreadClick(ev) {
  const cardChip = ev.target.closest('.card-ref-chip');
  if (cardChip) { openCardModal(cardChip.getAttribute('data-card-id')); return; }
  const thumb = ev.target.closest('.mermaid-thumb');
  if (!thumb) return;
  const svgEl = thumb.querySelector('svg');
  if (!svgEl) return;
  openMermaidModal(dedupeSvgIds(svgEl.cloneNode(true)));
}

// ── wire ────────────────────────────────────────────────────────────────
$('company').addEventListener('change', () => { company = $('company').value; roomId = ''; $('app').classList.remove('showchat'); loadRooms().then(() => loadThread()); });
$('newTopic').addEventListener('click', newTopic);
$('roomFilterToggle').addEventListener('click', () => { showClosed = !showClosed; renderRoomList(); });
$('send').addEventListener('click', send);
$('text').addEventListener('input', onComposeInput);
function pickActive() { const oracle = pickerItems[pickerActiveIndex]; pickTag(oracle, !participants.includes(oracle)); }
$('text').addEventListener('keydown', (ev) => {
  if (pickerItems.length && (ev.key === 'Escape')) { ev.preventDefault(); closePicker(); return; }
  if (pickerItems.length && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    ev.preventDefault(); // kobo-392: keep the text caret from moving while browsing the picker
    const delta = ev.key === 'ArrowDown' ? 1 : -1;
    setActiveIndex(Math.min(Math.max(pickerActiveIndex + delta, 0), pickerItems.length - 1)); // clamp, no wrap
    return;
  }
  if (pickerItems.length && ev.key === 'Tab') { ev.preventDefault(); pickActive(); return; } // preventDefault: keep focus in the box
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    if (pickerItems.length) { pickActive(); return; }
    send();
  }
});
$('text').addEventListener('blur', () => setTimeout(closePicker, 150)); // 150ms: let a picker-item mousedown fire first
$('text').addEventListener('paste', onComposePaste); // kobo-397: image paste
$('text').addEventListener('dragover', (ev) => { ev.preventDefault(); }); // kobo-397: allow drop
$('text').addEventListener('drop', onComposeDrop); // kobo-397: image drag-drop
$('thread').addEventListener('click', onThreadClick); // kobo-422: ONE delegated listener — survives loadThread's 2.5s replaceChildren
$('mmdModalClose').addEventListener('click', closeMermaidModal);
$('mermaidModal').addEventListener('click', (ev) => { if (ev.target.id === 'mermaidModal' || ev.target.classList.contains('mmd-modal-backdrop')) closeMermaidModal(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMermaidModal(); });
$('back').addEventListener('click', () => { $('app').classList.remove('showchat'); });
$('distillBtn').addEventListener('click', distill);
$('inviteBtn').addEventListener('click', invite);
$('mergeBtn').addEventListener('click', enterMerge);
$('closeBtn').addEventListener('click', toggleRoomOpen);
$('mergeConfirm').addEventListener('click', confirmMerge);
$('mergeCancel').addEventListener('click', cancelMerge);

(async function init() {
  await loadRooms();
  if (roomId) selectRoom(roomId);
})();
setInterval(() => { if (roomId) loadThread(); }, 2500); // poll for the lead's async reply (kobo-240)
</script>
</body>
</html>`;
}

export const roomView = new Hono();
roomView.get("/", (c) => c.html(roomHtml()));
