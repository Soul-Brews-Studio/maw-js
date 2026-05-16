import { Hono } from "hono";

export function messagesHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw messages</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --bad:#ff8e8e; --warn:#ffd37a; --accent:#7dd3fc; }
    * { box-sizing: border-box; }
    body { margin:0; padding:24px; font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:18px; }
    h1 { margin:0; font-size:22px; letter-spacing:.02em; }
    .sub { color:var(--muted); margin-top:4px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 12px 28px rgba(0,0,0,.25); }
    form { display:grid; grid-template-columns: repeat(6, minmax(110px, 1fr)); gap:10px; margin-bottom:14px; }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:5px; }
    input, select, button { background:#0d131c; color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; }
    button { cursor:pointer; border-color:#31516b; color:var(--accent); }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:8px 7px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left; }
    th { color:var(--muted); font-weight:600; font-size:12px; position:sticky; top:0; background:var(--card); }
    .pill { border:1px solid var(--line); border-radius:999px; padding:2px 7px; white-space:nowrap; }
    .delivered { color:var(--ok); } .failed { color:var(--bad); } .queued { color:var(--warn); }
    .muted { color:var(--muted); } .text { white-space:pre-wrap; word-break:break-word; max-width:42vw; }
    .empty, .error { color:var(--muted); padding:22px; text-align:center; }
    .error { color:var(--bad); }
    @media (max-width: 900px) { body { padding:12px; } header, form { display:block; } label { margin:8px 0; } .text { max-width:none; } table { font-size:12px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>maw messages</h1>
      <div class="sub">SQLite-backed hey/message lifecycle ledger via <code>/api/messages</code></div>
    </div>
    <button id="refresh" type="button">refresh</button>
  </header>
  <main class="card">
    <form id="filters">
      <label>limit <input name="limit" type="number" min="1" max="1000" value="100" /></label>
      <label>from <input name="from" placeholder="m5:oracle" /></label>
      <label>to <input name="to" placeholder="m5:oracle" /></label>
      <label>direction <select name="direction"><option value="">any</option><option>outbound</option><option>inbound</option><option>forwarded</option></select></label>
      <label>state <select name="state"><option value="">any</option><option>delivered</option><option>queued</option><option>failed</option></select></label>
      <label>search <input name="q" placeholder="text/error/target" /></label>
    </form>
    <div id="status" class="muted">loading…</div>
    <table aria-label="message ledger">
      <thead><tr><th>time</th><th>state</th><th>route</th><th>from</th><th></th><th>to</th><th>message</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </main>
<script>
const form = document.getElementById('filters');
const rows = document.getElementById('rows');
const statusEl = document.getElementById('status');
const refresh = document.getElementById('refresh');
function arrow(direction) { return direction === 'inbound' ? '←' : direction === 'forwarded' ? '↝' : '→'; }
function text(value) { return value == null ? '' : String(value); }
function cell(tr, value, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text(value); tr.appendChild(td); return td; }
function params() {
  const out = new URLSearchParams();
  new FormData(form).forEach((value, key) => { if (String(value).trim()) out.set(key, String(value).trim()); });
  return out;
}
async function load() {
  statusEl.textContent = 'loading…';
  rows.replaceChildren();
  try {
    const res = await fetch('/api/messages?' + params().toString(), { headers: { accept: 'application/json' } });
    const payload = await res.json();
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    statusEl.textContent = messages.length + ' row' + (messages.length === 1 ? '' : 's') + (payload.source ? ' from ' + payload.source : '');
    if (messages.length === 0) {
      const tr = document.createElement('tr'); const td = cell(tr, 'no messages recorded', 'empty'); td.colSpan = 7; rows.appendChild(tr); return;
    }
    for (const msg of messages) {
      const tr = document.createElement('tr');
      cell(tr, msg.ts || '', 'muted');
      cell(tr, msg.state || '', 'pill ' + (msg.state || ''));
      cell(tr, [msg.direction, msg.route, msg.channel].filter(Boolean).join('/'), 'muted');
      cell(tr, msg.from || '');
      cell(tr, arrow(msg.direction), 'muted');
      cell(tr, msg.to || '');
      const body = [msg.text, msg.error ? 'error: ' + msg.error : '', msg.lastLine ? '⤷ ' + msg.lastLine : ''].filter(Boolean).join('\n');
      cell(tr, body, 'text');
      rows.appendChild(tr);
    }
  } catch (err) {
    statusEl.textContent = 'failed to load /api/messages: ' + (err && err.message ? err.message : err);
    statusEl.className = 'error';
  }
}
form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
form.addEventListener('change', load);
refresh.addEventListener('click', load);
load();
</script>
</body>
</html>`;
}

export const messagesView = new Hono();
messagesView.get("/", (c) => c.html(messagesHtml()));
