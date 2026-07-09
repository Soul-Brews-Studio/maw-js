import { Hono } from "hono";

// Brainstorm Room — core wire (kobo-245, slice 1). A clean web surface to consult
// the company lead: type → `maw hey` to the lead (POST /api/room/send) → the lead
// replies with a `[room:<id>]`-tagged hey → both sides render here by filtering the
// public /api/feed on the room tag. NO new transport/session/pane — hey + feed only.
// This whole file is ONE template literal: keep the client JS backtick-free (string
// concat), mirroring messages.ts.
export function roomHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw brainstorm room</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --accent:#ff5f87; --link:#ffd700; }
    * { box-sizing: border-box; }
    body { margin:0; padding:24px; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:14px; }
    h1 { margin:0; font-size:20px; }
    .sub { color:var(--muted); margin-top:4px; font-size:12px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }
    .setup { display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:4px; }
    input, button { background:#0d131c; color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; }
    button { cursor:pointer; border-color:#31516b; color:var(--accent); }
    #thread { display:flex; flex-direction:column; gap:8px; max-height:60vh; overflow-y:auto; margin-bottom:12px; }
    .msg { border:1px solid var(--line); border-left:3px solid var(--line); border-radius:10px; padding:8px 11px; }
    .msg .who { color:var(--muted); font-size:12px; margin-bottom:3px; }
    .msg .body { white-space:pre-wrap; word-break:break-word; }
    .msg.mine { border-left-color:var(--accent); } .msg.lead { border-left-color:var(--link); }
    .composer { display:flex; gap:8px; }
    .composer input { flex:1 1 auto; }
    .status { color:var(--muted); font-size:12px; margin-top:8px; } .status.err { color:var(--bad,#ff8e8e); }
    .empty { color:var(--muted); padding:18px; text-align:center; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🧠 brainstorm room</h1>
      <div class="sub">web ⇄ lead over hey — rendered from <code>/api/feed</code> by room tag (kobo-245 core wire)</div>
    </div>
    <button id="refresh" type="button">refresh</button>
  </header>
  <main class="card">
    <div class="setup">
      <label>room <input id="room" value="demo" /></label>
      <label>lead (hey target) <input id="lead" placeholder="e.g. eq3 or m5:eq3" /></label>
      <label>me <input id="me" value="web" /></label>
    </div>
    <div id="thread"><div class="empty">no messages yet — type below to consult the lead</div></div>
    <div class="composer">
      <input id="text" placeholder="ask the lead… (Enter to send)" />
      <button id="send" type="button">send</button>
    </div>
    <div id="status" class="status"></div>
  </main>
<script>
const $ = (id) => document.getElementById(id);
const thread = $('thread'), statusEl = $('status');
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function roomTag() { return '[room:' + $('room').value.trim() + ']'; }
function strip(text) { return String(text || '').split(roomTag()).join('').trim(); }
function setStatus(msg, err) { statusEl.textContent = msg; statusEl.className = 'status' + (err ? ' err' : ''); }

async function load() {
  const room = $('room').value.trim();
  if (!room) return;
  try {
    const res = await fetch('/api/feed?limit=200', { headers: { accept: 'application/json' } });
    const payload = await res.json();
    const events = Array.isArray(payload.events) ? payload.events : [];
    // messages that belong to this room = hey lifecycle events whose text carries the room tag
    const msgs = events
      .filter((e) => (e.event === 'MessageSend' || e.event === 'MessageDeliver') && e.data && typeof e.data.text === 'string' && e.data.text.includes('[room:' + room + ']'))
      .map((e) => ({ from: e.data.from || e.oracle || '?', to: e.data.to || '', text: e.data.text, ts: e.ts || 0 }))
      .sort((a, b) => a.ts - b.ts);
    // de-dup (outbound + inbound lifecycle of the same hey → one bubble per from+text)
    const seen = new Set(); const uniq = [];
    for (const m of msgs) { const k = m.from + '|' + m.text; if (seen.has(k)) continue; seen.add(k); uniq.push(m); }
    thread.replaceChildren();
    if (!uniq.length) { thread.appendChild(el('div', 'empty', 'no messages in room "' + room + '" yet')); return; }
    const me = $('me').value.trim();
    for (const m of uniq) {
      const mine = m.from === me;
      const box = el('div', 'msg ' + (mine ? 'mine' : 'lead'));
      box.appendChild(el('div', 'who', m.from + (m.to ? ' → ' + m.to : '')));
      box.appendChild(el('div', 'body', strip(m.text)));
      thread.appendChild(box);
    }
    thread.scrollTop = thread.scrollHeight;
  } catch (err) { setStatus('feed load failed: ' + (err && err.message ? err.message : err), true); }
}

async function send() {
  const room = $('room').value.trim(), to = $('lead').value.trim(), text = $('text').value.trim();
  if (!room || !to || !text) { setStatus('room, lead and message are required', true); return; }
  $('send').disabled = true;
  try {
    const res = await fetch('/api/room/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: room, to: to, text: text }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'send failed');
    $('text').value = ''; setStatus('sent to ' + to + ' — waiting for reply…');
    setTimeout(load, 400);
  } catch (err) { setStatus('send failed: ' + (err && err.message ? err.message : err), true); }
  finally { $('send').disabled = false; }
}

$('send').addEventListener('click', send);
$('text').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
$('refresh').addEventListener('click', load);
$('room').addEventListener('change', load);
load();
setInterval(load, 2500); // poll the feed for the lead's reply (kobo-240: reply is async)
</script>
</body>
</html>`;
}

export const roomView = new Hono();
roomView.get("/", (c) => c.html(roomHtml()));
