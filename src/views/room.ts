import { Hono } from "hono";

// Brainstorm Room (kobo-245 wire + kobo-241 artifact). A clean web surface to consult
// the company lead: type → hey to the lead (POST /api/room/send) → the lead replies
// with a `[room:<id>]`-tagged hey → the room feed listener appends both turns to the
// OFF-CARD artifact rooms/<id>.json → this view renders the persisted thread from
// GET /api/room/thread (durable, so a reopen reloads the full conversation). NO new
// transport/session/pane. This whole file is ONE template literal: keep the client JS
// backtick-free (string concat), mirroring messages.ts.
export function roomHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw brainstorm room</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --bad:#ff8e8e; --accent:#ff5f87; --link:#ffd700; }
    * { box-sizing: border-box; }
    body { margin:0; padding:24px; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:14px; }
    h1 { margin:0; font-size:20px; }
    .sub { color:var(--muted); margin-top:4px; font-size:12px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }
    .setup { display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:4px; }
    input, button { background:#0d131c; color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; }
    button { cursor:pointer; border-color:#31516b; color:var(--accent); }
    .roomctl { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
    .rstatus { font-size:12px; color:var(--muted); }
    .rstatus .open { color:var(--ok); } .rstatus .closed { color:var(--bad); }
    #thread { display:flex; flex-direction:column; gap:8px; max-height:56vh; overflow-y:auto; margin-bottom:12px; }
    .msg { border:1px solid var(--line); border-left:3px solid var(--line); border-radius:10px; padding:8px 11px; }
    .msg .who { color:var(--muted); font-size:12px; margin-bottom:3px; }
    .msg .body { white-space:pre-wrap; word-break:break-word; }
    .msg.mine { border-left-color:var(--accent); } .msg.lead { border-left-color:var(--link); }
    .composer { display:flex; gap:8px; }
    .composer input { flex:1 1 auto; }
    .status { color:var(--muted); font-size:12px; margin-top:8px; } .status.err { color:var(--bad); }
    .empty { color:var(--muted); padding:18px; text-align:center; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🧠 brainstorm room</h1>
      <div class="sub">web ⇄ lead over hey; thread persists off-card in <code>rooms/&lt;id&gt;.json</code> (kobo-241)</div>
    </div>
    <button id="refresh" type="button">refresh</button>
  </header>
  <main class="card">
    <div class="setup">
      <label>company <input id="company" value="kobo" /></label>
      <label>room <input id="room" value="demo" /></label>
      <label>topic <input id="topic" placeholder="what to brainstorm" /></label>
      <label>lead (hey target) <input id="lead" placeholder="e.g. eq3 or m5:eq3" /></label>
      <label>me <input id="me" value="web" /></label>
    </div>
    <div class="roomctl">
      <button id="open" type="button">open / reopen</button>
      <button id="close" type="button">close</button>
      <span id="rstatus" class="rstatus"></span>
    </div>
    <div id="thread"><div class="empty">open a room to start the thread</div></div>
    <div class="composer">
      <input id="text" placeholder="ask the lead… (Enter to send)" />
      <button id="send" type="button">send</button>
    </div>
    <div class="roomctl" style="margin-top:12px">
      <label>distill → card <input id="dtitle" placeholder="distilled outcome (problem+approach)" /></label>
      <label>assignee <input id="dassignee" placeholder="optional" /></label>
      <label>reviewer <input id="dreviewer" placeholder="optional" /></label>
      <button id="distill" type="button">distill → card</button>
    </div>
    <div id="status" class="status"></div>
  </main>
<script>
const $ = (id) => document.getElementById(id);
const thread = $('thread'), statusEl = $('status');
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function setStatus(msg, err) { statusEl.textContent = msg; statusEl.className = 'status' + (err ? ' err' : ''); }
function ctx() { return { company: $('company').value.trim(), room: $('room').value.trim() }; }

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || (url + ' failed'));
  return j;
}

// Render the PERSISTED thread from the off-card artifact (survives restart / reopen).
async function load() {
  const { company, room } = ctx();
  if (!company || !room) return;
  try {
    const res = await fetch('/api/room/thread?company=' + encodeURIComponent(company) + '&room=' + encodeURIComponent(room), { headers: { accept: 'application/json' } });
    if (res.status === 404) { renderStatus(null); thread.replaceChildren(el('div', 'empty', 'room "' + room + '" not opened yet')); return; }
    const j = await res.json();
    if (!j.ok || !j.room) { renderStatus(null); return; }
    renderStatus(j.room);
    const msgs = Array.isArray(j.room.messages) ? j.room.messages.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)) : [];
    thread.replaceChildren();
    if (!msgs.length) { thread.appendChild(el('div', 'empty', 'no messages in room "' + room + '" yet')); return; }
    const me = $('me').value.trim();
    for (const m of msgs) {
      const box = el('div', 'msg ' + (m.from === me ? 'mine' : 'lead'));
      box.appendChild(el('div', 'who', m.from || '?'));
      box.appendChild(el('div', 'body', m.text || ''));
      thread.appendChild(box);
    }
    thread.scrollTop = thread.scrollHeight;
  } catch (err) { setStatus('thread load failed: ' + (err && err.message ? err.message : err), true); }
}

function renderStatus(room) {
  const s = $('rstatus');
  if (!room) { s.replaceChildren(); return; }
  s.replaceChildren();
  s.appendChild(el('span', room.status === 'open' ? 'open' : 'closed', room.status === 'open' ? '● open' : '○ closed'));
  if (room.topic) s.appendChild(el('span', '', ' · ' + room.topic));
  if (room.cardId) s.appendChild(el('span', '', ' · 🧵 card ' + room.cardId)); // kobo-244: bidirectional link, artifact side
}

async function openRoom() {
  const { company, room } = ctx(); const topic = $('topic').value.trim();
  if (!company || !room) { setStatus('company and room are required', true); return; }
  try { await post('/api/room/open', { company, room, topic }); setStatus('room "' + room + '" open'); load(); }
  catch (err) { setStatus('open failed: ' + (err && err.message ? err.message : err), true); }
}
async function closeRoom() {
  const { company, room } = ctx();
  try { await post('/api/room/close', { company, room }); setStatus('room "' + room + '" closed (thread kept — reopen anytime)'); load(); }
  catch (err) { setStatus('close failed: ' + (err && err.message ? err.message : err), true); }
}

async function send() {
  const { room } = ctx(); const to = $('lead').value.trim(), text = $('text').value.trim();
  if (!room || !to || !text) { setStatus('room, lead and message are required', true); return; }
  $('send').disabled = true;
  try {
    await post('/api/room/send', { room, to, text });
    $('text').value = ''; setStatus('sent to ' + to + ' — waiting for reply…');
    setTimeout(load, 500);
  } catch (err) { setStatus('send failed: ' + (err && err.message ? err.message : err), true); }
  finally { $('send').disabled = false; }
}

// kobo-244: distill the grounding conversation into a board card (the one room→board
// touch). Server reuses addTask + writes the bidirectional card↔room link.
async function distill() {
  const { company, room } = ctx(); const title = $('dtitle').value.trim();
  if (!company || !room || !title) { setStatus('company, room and card title are required', true); return; }
  $('distill').disabled = true;
  try {
    const j = await post('/api/room/distill', { company, room, title, assignee: $('dassignee').value.trim(), reviewer: $('dreviewer').value.trim() });
    const id = j.card && j.card.id ? j.card.id : '?';
    setStatus('distilled → card ' + id + (j.deduped ? ' (already linked)' : ' created + linked'));
    $('dtitle').value = '';
    load();
  } catch (err) { setStatus('distill failed: ' + (err && err.message ? err.message : err), true); }
  finally { $('distill').disabled = false; }
}

$('open').addEventListener('click', openRoom);
$('close').addEventListener('click', closeRoom);
$('send').addEventListener('click', send);
$('distill').addEventListener('click', distill);
$('text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
$('refresh').addEventListener('click', load);
$('room').addEventListener('change', load);
$('company').addEventListener('change', load);
load();
setInterval(load, 2500); // poll the artifact for the lead's reply (kobo-240: reply is async)
</script>
</body>
</html>`;
}

export const roomView = new Hono();
roomView.get("/", (c) => c.html(roomHtml()));
