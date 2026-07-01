import { Hono } from "hono";

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

export function companyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw company</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --col:#0e141d; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --bad:#ff8e8e; --warn:#ffd37a; --accent:#7dd3fc; }
    body.light { color-scheme: light; --bg:#f6f8fb; --card:#ffffff; --col:#eef2f7; --muted:#5b6b77; --fg:#1b2430; --line:#d8e0ea; --ok:#1f9d57; --bad:#c8443a; --warn:#9a6b12; --accent:#1f6fd6; }
    * { box-sizing: border-box; }
    body { margin:0; padding:24px; font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); transition:background .2s ease, color .2s ease; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap; }
    h1 { margin:0; font-size:22px; letter-spacing:.02em; }
    h1 .co { color:var(--accent); }
    .sub { color:var(--muted); margin-top:4px; }
    .controls { display:flex; gap:10px; align-items:flex-end; }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:5px; }
    input, button { background:#0d131c; color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; }
    button { cursor:pointer; border-color:#31516b; color:var(--accent); }
    .layout { display:grid; grid-template-columns: 1fr 360px; gap:16px; align-items:start; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 12px 28px rgba(0,0,0,.25); }
    .board { display:grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap:10px; overflow-x:auto; }
    .col { background:var(--col); border:1px solid var(--line); border-radius:12px; padding:10px; min-height:120px; }
    .col h2 { margin:0 0 10px; font-size:12px; font-weight:600; color:var(--muted); display:flex; justify-content:space-between; gap:6px; }
    .col h2 .count { color:var(--fg); }
    .col-backlog h2 { color:var(--muted); } .col-todo h2 { color:var(--warn); }
    .col-in-progress h2 { color:var(--accent); } .col-review h2 { color:#c4a7ff; } .col-done h2 { color:var(--ok); }
    .attention { margin-top:14px; border:1px solid #6b3a3a; background:#1b1012; border-radius:12px; padding:10px; }
    .attention h2 { margin:0 0 8px; font-size:12px; color:var(--bad); display:flex; justify-content:space-between; }
    .attention .lane { display:flex; gap:9px; flex-wrap:wrap; }
    .attention .task { flex:1 1 220px; max-width:340px; }
    .task { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:9px 10px; margin-bottom:9px; }
    .task .t-title { color:var(--fg); }
    .task .t-meta { color:var(--muted); font-size:12px; margin-top:5px; display:flex; gap:6px; flex-wrap:wrap; }
    .task .t-na { color:var(--accent); font-size:12px; margin-top:6px; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:1px 7px; white-space:nowrap; }
    .pill.dept { color:var(--accent); } .pill.epic { color:#c4a7ff; } .pill.assignee { color:var(--ok); }
    .pill.pr { color:var(--warn); } .pill.wait { color:var(--warn); border-color:#5a4a22; }
    .pill.check { color:#c4a7ff; }
    .pill.attn { color:var(--bad); border-color:#6b3a3a; }
    .timeline { max-height:72vh; overflow:auto; }
    .entry { padding:8px 4px; border-bottom:1px solid var(--line); }
    .entry:last-child { border-bottom:0; }
    .entry .e-head { display:flex; gap:8px; align-items:baseline; }
    .entry .e-oracle { color:var(--accent); } .entry .e-kind { color:var(--muted); font-size:12px; }
    .entry .e-ts { color:var(--muted); font-size:11px; margin-left:auto; }
    .entry .e-summary { color:var(--fg); margin-top:3px; white-space:pre-wrap; word-break:break-word; }
    .empty, .error { color:var(--muted); padding:18px; text-align:center; }
    .error { color:var(--bad); }
    .stack { display:flex; flex-direction:column; gap:16px; }
    .md { color:var(--fg); max-height:60vh; overflow:auto; font-size:13px; }
    .md h1,.md h2,.md h3,.md h4 { color:var(--accent); margin:14px 0 8px; line-height:1.3; }
    .md h1 { font-size:18px; } .md h2 { font-size:15px; } .md h3 { font-size:13px; } .md h4 { font-size:12px; color:var(--muted); }
    .md p { margin:8px 0; } .md ul,.md ol { margin:8px 0; padding-left:20px; } .md li { margin:3px 0; }
    .md code { background:#0d131c; border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
    .md pre { background:#0d131c; border:1px solid var(--line); border-radius:9px; padding:10px; overflow:auto; }
    .md pre code { background:none; border:0; padding:0; }
    .md blockquote { border-left:3px solid var(--line); margin:8px 0; padding:2px 0 2px 12px; color:var(--muted); }
    .md a { color:var(--accent); } .md hr { border:0; border-top:1px solid var(--line); margin:12px 0; }
    .md strong { color:var(--fg); } .md em { color:var(--warn); }
    @media (max-width: 880px) { body { padding:12px; } .layout { grid-template-columns: 1fr; } .board { grid-template-columns: 1fr; } .timeline, .md { max-height:none; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>maw company <span class="co" id="co-name">—</span></h1>
      <div class="sub">read-only board + worklog timeline · <code id="status">loading…</code></div>
    </div>
    <div class="controls">
      <label>company <input id="company" placeholder="pgw" /></label>
      <button id="theme" type="button" title="toggle light/dark" aria-label="toggle theme">🌙</button>
      <button id="refresh" type="button">refresh</button>
    </div>
  </header>
  <main class="layout">
    <section class="card">
      <div class="board">
        <div class="col col-backlog"><h2><span>Backlog</span><span class="count" id="c-backlog">0</span></h2><div id="backlog"></div></div>
        <div class="col col-todo"><h2><span>Todo</span><span class="count" id="c-todo">0</span></h2><div id="todo"></div></div>
        <div class="col col-in-progress"><h2><span>In&nbsp;progress</span><span class="count" id="c-in-progress">0</span></h2><div id="in-progress"></div></div>
        <div class="col col-review"><h2><span>Review</span><span class="count" id="c-review">0</span></h2><div id="review"></div></div>
        <div class="col col-done"><h2><span>Done</span><span class="count" id="c-done">0</span></h2><div id="done"></div></div>
      </div>
      <div class="attention" id="attention-panel" hidden>
        <h2><span>⚑ Blocked <span style="color:var(--muted);font-weight:400">(off-flow)</span></span><span class="count" id="c-blocked">0</span></h2>
        <div class="lane" id="blocked"></div>
      </div>
    </section>
    <aside class="stack">
      <div class="card">
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted)">worklog timeline</h2>
        <div class="timeline" id="timeline"></div>
      </div>
      <div class="card" id="state-panel" hidden>
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted)">coordination state</h2>
        <div class="md" id="state-md"></div>
      </div>
      <div class="card" id="detail-panel" hidden>
        <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between">card detail <span id="detail-close" style="cursor:pointer;color:var(--muted)">✕</span></h2>
        <div id="detail-title" style="font-weight:600;margin-bottom:8px"></div>
        <div class="md" id="detail-body"></div>
      </div>
    </aside>
  </main>
<script>
const $ = (id) => document.getElementById(id);
const companyInput = $('company');
const statusEl = $('status');

function text(v) { return v == null ? '' : String(v); }
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = String(txt); return e; }
function currentCompany() { return (companyInput.value || '').trim(); }

// "X รอ Y" — derived, never stored (ADR §4): by≠assignee · state≠done.
function waitFor(task) {
  if (task.assignee && task.by && task.by !== task.assignee && task.state !== 'done') {
    return task.by + '→' + task.assignee;
  }
  return null;
}

function taskCard(task) {
  const card = el('div', 'task');
  card.appendChild(el('div', 't-title', task.title || '(untitled)'));
  const meta = el('div', 't-meta');
  meta.appendChild(el('span', 'pill', text(task.id)));
  if (task.dept) meta.appendChild(el('span', 'pill dept', task.dept));
  if (task.epic) meta.appendChild(el('span', 'pill epic', '⊳' + task.epic));
  if (task.assignee) meta.appendChild(el('span', 'pill assignee', '@' + task.assignee));
  else meta.appendChild(el('span', 'pill', '(unassigned)'));
  const wf = waitFor(task);
  if (wf) meta.appendChild(el('span', 'pill wait', '⏳ ' + wf));
  if (task.checklist && task.checklist.total) meta.appendChild(el('span', 'pill check', '☑ ' + task.checklist.done + '/' + task.checklist.total));
  if (task.pr) meta.appendChild(el('span', 'pill pr', 'PR #' + task.pr));
  if (task.block) meta.appendChild(el('span', 'pill attn', '⚑ ' + task.block.kind + (task.block.for ? ' →' + task.block.for : '') + (task.block.reason ? ': ' + task.block.reason : '')));
  // derived blocked-by-dependency (ADR 0003 A on web) — NOT a block state; the card waits on a parent
  if (task.dependency && task.dependency.blockedBy.length) meta.appendChild(el('span', 'pill attn', '🚫 รอ: ' + task.dependency.blockedBy.join(', ')));
  if (task.dependency && task.dependency.missing.length) meta.appendChild(el('span', 'pill wait', '⚠ parent ไม่พบ: ' + task.dependency.missing.join(', ')));
  if (task.needsOwner) meta.appendChild(el('span', 'pill attn', '⚑ ยังไม่มีเจ้าของ')); // derived needs-owner (kobo-14)
  card.appendChild(meta);
  // next-action — the board always says what happens next + who (Track 4)
  if (task.nextAction) card.appendChild(el('div', 't-na', '↳ ' + task.nextAction));
  // click → read-only detail panel (eq3-010 kobo-11)
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => openDetail(task));
  return card;
}

// Read-only card detail — title + meta + body markdown (reuses mdToHtml).
function openDetail(task) {
  $('detail-title').textContent = (task.id ? task.id + ' · ' : '') + (task.title || '(untitled)');
  const bodyEl = $('detail-body');
  if (task.body) { bodyEl.innerHTML = mdToHtml(task.body); }
  else { const p = el('p', '', '(no detail — add one with: maw task add ... --body)'); p.style.color = 'var(--muted)'; bodyEl.replaceChildren(p); }
  $('detail-panel').hidden = false;
}

const FLOW = ['backlog', 'todo', 'in-progress', 'review', 'done'];

function renderBoard(tasks) {
  const cols = {};
  for (const s of FLOW) { cols[s] = $(s); cols[s].replaceChildren(); }
  const attn = $('blocked'); attn.replaceChildren();
  const counts = { backlog: 0, todo: 0, 'in-progress': 0, review: 0, done: 0, blocked: 0 };
  // Off-flow = explicit block (state) OR derived dependency block (ADR 0003) —
  // ONE Blocked lane, mirroring the CLI board. Derived cards keep their real
  // flow state but are pulled out while a parent is pending; when the parent is
  // done the next poll drops the dependency field and the card returns.
  const isOffFlow = (task) => task.state === 'blocked' || (task.dependency && task.dependency.blockedBy.length > 0) || task.needsOwner;
  for (const task of tasks) {
    if (isOffFlow(task)) { attn.appendChild(taskCard(task)); counts['blocked']++; continue; }
    const state = cols[task.state] ? task.state : 'todo';
    cols[state].appendChild(taskCard(task));
    counts[state]++;
  }
  for (const s of FLOW) {
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
    const head = el('div', 'e-head');
    head.appendChild(el('span', 'e-oracle', e.oracle || '?'));
    head.appendChild(el('span', 'e-kind', e.kind || ''));
    const ts = e.iso ? localTs(e.iso) : text(e.ts);
    head.appendChild(el('span', 'e-ts', ts));
    row.appendChild(head);
    row.appendChild(el('div', 'e-summary', e.summary || ''));
    tl.appendChild(row);
  }
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
    if ((m = line.match(/^\\s*[-*+]\\s+(.*)$/))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push('<li>' + inlineMd(m[1]) + '</li>'); i++; continue; }
    if ((m = line.match(/^\\s*\\d+\\.\\s+(.*)$/))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inlineMd(m[1]) + '</li>'); i++; continue; }
    closeList(); out.push('<p>' + inlineMd(line) + '</p>'); i++;
  }
  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\\n');
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
  if (!company) { statusEl.textContent = 'specify ?company= (e.g. /company?company=pgw)'; renderBoard([]); renderTimeline([]); renderState(null); return; }
  statusEl.textContent = 'loading…';
  statusEl.className = '';
  try {
    const q = '?company=' + encodeURIComponent(company);
    // state panel is optional — a failed/absent state.md must not break the page.
    const [tasksRes, feedRes, stateRes] = await Promise.all([
      getJson('/api/tasks' + q),
      getJson('/api/worklog/feed' + q + '&limit=50'),
      getJson('/api/state' + q).catch(() => null),
    ]);
    const tasks = Array.isArray(tasksRes.tasks) ? tasksRes.tasks : [];
    const entries = Array.isArray(feedRes.entries) ? feedRes.entries : [];
    renderBoard(tasks);
    renderTimeline(entries);
    renderState(stateRes);
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
$('detail-close').addEventListener('click', () => { $('detail-panel').hidden = true; });
load();
</script>
</body>
</html>`;
}

export const companyView = new Hono();
companyView.get("/", (c) => c.html(companyHtml()));
