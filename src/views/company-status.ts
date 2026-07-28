import { Hono } from "hono";

/**
 * Company status (kobo-445) — per-oracle rollup: pending work + presence +
 * worklog, ONE card per oracle instead of 3 separate tabs a reader has to
 * cross-reference. Deliberately separate page from /company (the kanban
 * board) — different question ("what is each oracle doing right now") vs
 * the board's ("what state is each card in").
 *
 * READ-ONLY (Tony's explicit constraint) — fetches only, zero POST/write.
 * Sources: GET /api/roster (membership + held + pending, kobo-445 rev),
 * GET /api/presence (per-pane ctx%), GET /api/worklog/feed (recent activity).
 *
 * kobo-445 review round 1: this used to also fetch GET /api/tasks for the
 * pending list — 848KB / 532-file server-side scan, every 5s, forever, per
 * open tab. /api/roster ALREADY does that same file scan (for `held`); the
 * fix is having it also return the full per-oracle pending set (id/title/
 * state only — see pendingTasksByOracle in core/presence/held.ts) instead
 * of a second, heavier route computing the same thing. Measured on the real
 * kobo company (chrome-devtools network panel, this PR, single measurement
 * by me — not independently re-verified yet since the field wasn't live on
 * any server at review time): /api/roster with `pending` added was 32554
 * bytes, vs 848KB for /api/tasks.
 *
 * kobo-445 review round 2: two more real gaps caught —
 *   1. the 5s poll never paused for a hidden/backgrounded tab, and never
 *      checked for one still running when the next tick fired. Fixed below
 *      (visibilitychange + loadInFlight guard) and the interval lengthened
 *      to 15s — this is a status dashboard, not a live board, so 15s-stale
 *      is an acceptable tradeoff for a much lower steady-state request rate.
 *   2. handleRosterRequest was STILL calling listTasks(company) twice per
 *      request (once inside heldWorkByOracle, once inside pendingTasksByOracle)
 *      even after round 1 — the comment above claimed "one shared file-scan"
 *      but the code didn't do that yet. Fixed in core/roster/route.ts: listTasks
 *      is now called once and passed into both functions (see held.ts's updated
 *      signatures + the mock-free test proving the param is actually honored,
 *      not silently ignored).
 */
export function companyStatusHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>maw company status</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#121822; --col:#0e141d; --muted:#91a0b5; --fg:#e8edf5; --line:#243044; --ok:#8ddf9a; --bad:#ff8e8e; --warn:#ffd37a; --accent:#ff5f87; --link:#ffd700; --field-bg:#0d131c; } /* kobo-71 palette (mirror of company.ts) */
    * { box-sizing: border-box; }
    body { margin:0; padding:24px; font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap; }
    h1 { margin:0; font-size:22px; letter-spacing:.02em; }
    .sub { color:var(--muted); margin-top:4px; font-size:12px; }
    .controls { display:flex; gap:10px; align-items:flex-end; }
    label { color:var(--muted); font-size:12px; display:flex; flex-direction:column; gap:5px; }
    input, button { background:var(--field-bg); color:var(--fg); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:inherit; }
    button { cursor:pointer; border-color:#31516b; color:var(--accent); }
    #status { color:var(--muted); margin-bottom:14px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:14px; }
    .oc { min-width:0; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 12px 28px rgba(0,0,0,.25); } /* min-width:0 — a grid item's default min-width:auto lets long unbreakable content (Thai titles) blow the card past its track (kobo-198 bug class) */
    .oc.is-active { border-left-color:var(--ok); }
    .oc.is-idle-work { border-left-color:var(--warn); }
    .oc.is-error { border-left-color:var(--bad); }
    .oc-head { display:flex; align-items:center; gap:8px; }
    .oc-name { color:var(--fg); font-weight:700; font-size:15px; }
    .oc-role { color:var(--muted); font-size:11px; }
    .badge { margin-left:auto; flex:0 0 auto; font-size:11px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; }
    .badge.active { color:var(--ok); border-color:var(--ok); }
    .badge.idle { color:var(--muted); }
    .badge.idle-work { color:var(--warn); border-color:var(--warn); }
    .badge.error { color:var(--bad); border-color:var(--bad); }
    .section { margin-top:10px; }
    .section h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
    .panes { display:flex; flex-direction:column; gap:3px; }
    .pane-row { display:flex; gap:8px; font-size:12px; color:var(--muted); }
    .pane-row .p-id { color:var(--accent); }
    .pane-row .p-ctx { margin-left:auto; }
    .pending-row { display:flex; gap:8px; align-items:baseline; font-size:12px; padding:3px 0; border-top:1px dashed var(--line); }
    .pending-row:first-child { border-top:0; }
    .pending-row .p-title { color:var(--fg); flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pending-row .p-state { flex:0 0 auto; font-size:10px; border:1px solid var(--line); border-radius:999px; padding:1px 7px; color:var(--muted); white-space:nowrap; }
    .pending-more { color:var(--muted); font-size:11px; font-style:italic; margin-top:2px; }
    .wl-row { font-size:12px; padding:3px 0; border-top:1px dashed var(--line); }
    .wl-row:first-child { border-top:0; }
    .wl-row .wl-kind { color:var(--muted); font-size:10px; border:1px solid var(--line); border-radius:999px; padding:0 6px; margin-right:6px; }
    .wl-row .wl-ts { color:var(--muted); font-size:10px; float:right; }
    .wl-row .wl-summary { color:var(--fg); display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .empty-note { color:var(--muted); font-size:12px; font-style:italic; }
    .empty, .error { color:var(--muted); padding:22px; text-align:center; }
    .error { color:var(--bad); }
    @media (max-width: 700px) { body { padding:12px; } header { display:block; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>maw company status</h1>
      <div class="sub">ต่อ oracle: ของค้าง · presence · worklog ในที่เดียว (read-only) — <code>/company</code> is the kanban board, this is not it</div>
    </div>
    <div class="controls">
      <label>company <input id="company" placeholder="kobo" autocomplete="off" /></label>
      <button id="refresh" type="button">refresh</button>
    </div>
  </header>
  <div id="status">loading…</div>
  <div id="grid" class="grid"></div>
<script>
const ACTIVE_MS = 10 * 60 * 1000;
const companyInput = document.getElementById('company');
const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');

function companyFromUrl() {
  return (new URLSearchParams(window.location.search).get('company') || '').trim();
}
function text(v) { return v == null ? '' : String(v); }
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = String(txt); return e; }
function nowMs() { return Date.now(); }
function relTime(ts) {
  if (!ts) return '—';
  const diff = nowMs() - ts;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
  return Math.round(diff / 86400000) + 'd ago';
}
function ctxPct(p) {
  if (!p) return null;
  if (typeof p.total_input_tokens === 'number' && typeof p.context_window_size === 'number' && p.total_input_tokens > p.context_window_size) return null;
  if (typeof p.remaining_percentage === 'number') return Math.round(p.remaining_percentage);
  if (typeof p.used_percentage === 'number') return Math.round(100 - p.used_percentage);
  return null;
}
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' → ' + res.status);
  return res.json();
}

let loadInFlight = false;
async function load() {
  if (loadInFlight) return; // kobo-445 review round 1: never overlap a poll tick with a still-running one
  if (document.hidden) return; // kobo-445 review round 2: a backgrounded tab doesn't need live data
  loadInFlight = true;
  try {
    const company = (companyInput.value || '').trim();
    const url = new URL(window.location.href);
    if (company) url.searchParams.set('company', company); else url.searchParams.delete('company');
    window.history.replaceState(null, '', url.toString());
    if (!company) { statusEl.textContent = 'enter a company to load'; gridEl.replaceChildren(); return; }
    statusEl.textContent = 'loading…';
    try {
      const [rosterRes, presenceRes, worklogRes] = await Promise.all([
        getJson('/api/roster?company=' + encodeURIComponent(company) + '&pending=1'), // opt into the pending field — see roster/route.ts
        getJson('/api/presence?company=' + encodeURIComponent(company)),
        getJson('/api/worklog/feed?company=' + encodeURIComponent(company) + '&limit=300'),
      ]);
      render(rosterRes.roster || [], rosterRes.held || {}, rosterRes.pending || {}, presenceRes.rows || [], worklogRes.entries || []);
      statusEl.textContent = (rosterRes.roster || []).length + ' oracle(s) in ' + company;
    } catch (err) {
      statusEl.textContent = 'failed to load: ' + (err && err.message ? err.message : err);
      statusEl.className = 'error';
      gridEl.replaceChildren();
    }
  } finally {
    loadInFlight = false;
  }
}

function render(roster, held, pending, presence, worklog) {
  gridEl.replaceChildren();
  if (!roster.length) { gridEl.appendChild(el('div', 'empty', 'no roster members')); return; }

  // worklog: newest activity per oracle (kind 'idle'/'error'/'away' are pane-state
  // signals, not activity — same distinction the Presence tab uses).
  const lastActByOracle = new Map();
  const erroredOracles = new Set();
  const worklogByOracle = new Map();
  for (const e of worklog) {
    const oracle = e.oracle || '?';
    if (!worklogByOracle.has(oracle)) worklogByOracle.set(oracle, []);
    worklogByOracle.get(oracle).push(e);
    if (e.kind === 'error') erroredOracles.add(oracle);
    if (e.kind === 'idle' || e.kind === 'error' || e.kind === 'away') continue;
    const cur = lastActByOracle.get(oracle);
    if (!cur || (e.ts || 0) >= (cur.ts || 0)) lastActByOracle.set(oracle, e);
  }

  const panesByOracle = new Map();
  for (const p of presence) {
    if (!p || !p.oracle) continue;
    if (!panesByOracle.has(p.oracle)) panesByOracle.set(p.oracle, []);
    panesByOracle.get(p.oracle).push(p);
  }

  const now = nowMs();
  const rows = roster.map((member) => {
    const act = lastActByOracle.get(member.oracle) || null;
    const errored = erroredOracles.has(member.oracle);
    const active = !errored && !!(act && (now - (act.ts || 0)) <= ACTIVE_MS);
    const heldWork = held[member.oracle] || [];
    const idleWithWork = !errored && !active && heldWork.length > 0;
    return { member, act, errored, active, idleWithWork };
  });
  rows.sort((a, b) => {
    const rank = (x) => x.errored ? 0 : (x.active ? 1 : (x.idleWithWork ? 2 : 3));
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.member.oracle.localeCompare(b.member.oracle);
  });

  for (const row of rows) {
    const member = row.member;
    const cell = el('div', 'oc' + (row.errored ? ' is-error' : row.active ? ' is-active' : row.idleWithWork ? ' is-idle-work' : ''));
    const head = el('div', 'oc-head');
    head.appendChild(el('span', 'oc-name', member.oracle));
    const roleTxt = member.role ? (member.role + (member.dept ? ' · ' + member.dept : '')) : (member.dept || '');
    if (roleTxt) head.appendChild(el('span', 'oc-role', roleTxt));
    // kobo-445 review round 1 (non-blocking, decided): "active" was computed from
    // ANY worklog activity in the last 10 min — but the worklog also records messages
    // arriving TO an oracle (task-note "via hey→…" entries from others pinging them),
    // not just what the oracle itself did. An oracle sitting idle who gets pinged a lot
    // reads as falsely "active" — the exact "stale-that-looks-fresh" trap this page
    // exists to catch. Chose the honest-label fix over a fragile heuristic (parsing
    // "via hey→" out of free-text summaries would be brittle and easy to silently
    // break): say what's actually measured — recent activity in the feed, not
    // necessarily the oracle's own doing — rather than overclaiming "active".
    const badgeCls = row.errored ? 'badge error' : row.active ? 'badge active' : row.idleWithWork ? 'badge idle-work' : 'badge idle';
    const badgeTxt = row.errored ? '🛑 error' : row.active ? '● recent activity' : row.idleWithWork ? '⚠️ idle · มีงานค้าง' : '○ idle';
    const badgeEl = el('span', badgeCls, badgeTxt);
    if (row.active) badgeEl.title = 'worklog activity in the last 10 min — may include messages sent TO this oracle, not only what it did itself';
    head.appendChild(badgeEl);
    cell.appendChild(head);

    // presence: per-pane ctx%
    const panes = panesByOracle.get(member.oracle) || [];
    const paneSection = el('div', 'section');
    paneSection.appendChild(el('h3', null, 'presence'));
    if (panes.length) {
      const box = el('div', 'panes');
      for (const p of panes) {
        const r = el('div', 'pane-row');
        r.appendChild(el('span', 'p-id', '.' + (p.pane || '?')));
        r.appendChild(el('span', null, p.model || '—'));
        const pct = ctxPct(p);
        r.appendChild(el('span', 'p-ctx', pct == null ? 'ctx —' : 'ctx ' + pct + '% left' + (p.stale ? ' (stale)' : '')));
        box.appendChild(r);
      }
      paneSection.appendChild(box);
    } else {
      paneSection.appendChild(el('div', 'empty-note', 'no live pane'));
    }
    cell.appendChild(paneSection);

    // pending work — server-sorted newest-first, done/rejected already excluded
    // server-side (pendingTasksByOracle), so a closed card just isn't in this list.
    const oraclePending = pending[member.oracle] || [];
    const pendSection = el('div', 'section');
    pendSection.appendChild(el('h3', null, 'ของค้าง (' + oraclePending.length + ')'));
    if (oraclePending.length) {
      const CAP = 6;
      for (const t of oraclePending.slice(0, CAP)) {
        const r = el('div', 'pending-row');
        const title = el('span', 'p-title', t.id + ' — ' + t.title);
        title.title = t.title;
        r.appendChild(title);
        r.appendChild(el('span', 'p-state', t.state));
        pendSection.appendChild(r);
      }
      if (oraclePending.length > CAP) pendSection.appendChild(el('div', 'pending-more', '+' + (oraclePending.length - CAP) + ' more'));
    } else {
      pendSection.appendChild(el('div', 'empty-note', 'nothing pending'));
    }
    cell.appendChild(pendSection);

    // worklog: last 5
    const wlSection = el('div', 'section');
    wlSection.appendChild(el('h3', null, 'worklog ล่าสุด'));
    const wl = (worklogByOracle.get(member.oracle) || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 5);
    if (wl.length) {
      for (const e of wl) {
        const r = el('div', 'wl-row');
        r.appendChild(el('span', 'wl-ts', relTime(e.ts)));
        r.appendChild(el('span', 'wl-kind', e.kind || ''));
        const s = el('span', 'wl-summary', e.summary || '');
        s.title = e.summary || '';
        r.appendChild(s);
        wlSection.appendChild(r);
      }
    } else {
      wlSection.appendChild(el('div', 'empty-note', 'no recent activity'));
    }
    cell.appendChild(wlSection);

    gridEl.appendChild(cell);
  }
}

companyInput.value = companyFromUrl();
companyInput.addEventListener('change', load);
refreshBtn.addEventListener('click', load);
// kobo-445 review round 2: refresh immediately on regaining visibility (don't make
// the reader wait up to POLL_MS after switching back to this tab) — load() itself
// still skips a hidden tab, so this is the only trigger while backgrounded.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
load();
const POLL_MS = 15000; // kobo-445 review round 2: was 5000 — this is a status dashboard, not a live board
setInterval(load, POLL_MS);
</script>
</body>
</html>`;
}

export const companyStatusView = new Hono();
companyStatusView.get("/", (c) => c.html(companyStatusHtml()));
