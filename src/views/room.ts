import { Hono } from "hono";

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
    .bubble .body { white-space:pre-wrap; word-break:break-word; }
    .bubble .body a { color:var(--human); text-decoration:underline; }
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
let roomStatus = 'open';
let oracles = []; // kobo-390: company roster for the @-picker
let participants = []; // kobo-390: current room's explicit invite list

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
  box.replaceChildren();
  if (!rooms.length) {
    const e = el('div', 'list-empty');
    e.appendChild(el('div', null, 'ยังไม่มีห้องใน ' + company + '. เปิดหัวข้อแรกเพื่อปรึกษา ' + (lead || 'lead') + '.'));
    const b = el('button', 'primary', '+ New topic'); b.type = 'button'; b.addEventListener('click', newTopic);
    e.appendChild(b);
    box.appendChild(e);
    return;
  }
  for (const r of rooms) {
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
    const head = el('div', 'head');
    head.appendChild(el('span', 'nm', m.from || '?'));
    head.appendChild(el('span', 'pill', pillText(role)));
    head.appendChild(el('span', 'ts mono', fmtTs(m.ts)));
    b.appendChild(head);
    if (role === 'teammate') b.appendChild(el('div', 'tag', '🔎 pulled in'));
    const bodyEl = el('div', 'body');
    linkify(bodyEl, m.text || '');
    b.appendChild(bodyEl);
    thread.appendChild(b);
  }
  if (stick) thread.scrollTop = thread.scrollHeight;
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
    await post('/api/room/send', { room: roomId, to: lead, text: text, from: 'web' }); // web turn tagged human (kobo-248)
    $('text').value = ''; autogrow(); setStatus('sent to ' + lead + ' — waiting…');
    setTimeout(loadThread, 500);
  } catch (err) { setStatus('ส่งไม่สำเร็จ — retry: ' + (err && err.message ? err.message : err), true); }
  finally { $('send').disabled = false; }
}

// ── @-tag picker (kobo-390): grouped "in this room" vs "invite"; picking an
// invite entry fires the EXISTING /api/room/invite (auto-invite), then inserts the
// tag — narrow-scope routing (server) + broad-roster picker (client), bridged by invite.
let pickerItems = [];
function tagQueryAt(value, caret) {
  const head = value.slice(0, caret);
  const m = head.match(/(?:^|\s)@([a-z0-9][a-z0-9_.-]*)$/i);
  return m ? { start: caret - m[1].length - 1, query: m[1].toLowerCase() } : null;
}
function closePicker() { $('picker').style.display = 'none'; $('picker').replaceChildren(); pickerItems = []; }
function pickerRow(oracle, needsInvite) {
  const row = el('div', 'picker-item');
  row.appendChild(el('span', null, '@' + oracle));
  if (needsInvite) row.appendChild(el('span', 'hint', 'invite'));
  row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickTag(oracle, needsInvite); });
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
  if (!pickerItems.length) { closePicker(); return; }
  if (inRoom.length) box.appendChild(el('div', 'picker-group', 'in this room'));
  for (const o of inRoom) box.appendChild(pickerRow(o, false));
  if (invite.length) box.appendChild(el('div', 'picker-group', 'invite to room'));
  for (const o of invite) box.appendChild(pickerRow(o, true));
  box.style.display = '';
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

// ── wire ────────────────────────────────────────────────────────────────
$('company').addEventListener('change', () => { company = $('company').value; roomId = ''; $('app').classList.remove('showchat'); loadRooms().then(() => loadThread()); });
$('newTopic').addEventListener('click', newTopic);
$('send').addEventListener('click', send);
$('text').addEventListener('input', onComposeInput);
$('text').addEventListener('keydown', (ev) => {
  if (pickerItems.length && (ev.key === 'Escape')) { ev.preventDefault(); closePicker(); return; }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    if (pickerItems.length) { pickTag(pickerItems[0], !participants.includes(pickerItems[0])); return; }
    send();
  }
});
$('text').addEventListener('blur', () => setTimeout(closePicker, 150)); // 150ms: let a picker-item mousedown fire first
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
