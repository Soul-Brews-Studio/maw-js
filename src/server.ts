import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { listSessions, capture, sendKeys, selectWindow } from "./ssh";
import { processMirror } from "./overview";
import { FeedTailer } from "./feed-tail";
import type { ServerWebSocket } from "bun";

const app = new Hono();
app.use("/api/*", cors());

// API routes (keep for CLI compatibility)
app.get("/api/sessions", async (c) => c.json(await listSessions()));

app.get("/api/capture", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  return c.json({ content: await capture(target) });
});

app.get("/api/mirror", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.text("target required", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw = await capture(target);
  return c.text(processMirror(raw, lines));
});

app.post("/api/send", async (c) => {
  const { target, text } = await c.req.json();
  if (!target || !text) return c.json({ error: "target and text required" }, 400);
  await sendKeys(target, text);
  return c.json({ ok: true, target, text });
});

app.post("/api/select", async (c) => {
  const { target } = await c.req.json();
  if (!target) return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});

// Serve UI
const html = Bun.file(import.meta.dir + "/ui.html");
app.get("/", (c) => c.body(html.stream(), { headers: { "Content-Type": "text/html" } }));

const dashboardHtml = Bun.file(import.meta.dir + "/dashboard.html");
app.get("/dashboard", (c) => c.body(dashboardHtml.stream(), { headers: { "Content-Type": "text/html" } }));

// Serve React office app (built by vite to dist-office/)
app.get("/office", serveStatic({ root: "./dist-office", path: "/index.html" }));
app.get("/office/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/office/, "/dist-office"),
}));

// Serve 8-bit office (Bevy WASM)
app.get("/office-8bit", serveStatic({ root: "./dist-8bit-office", path: "/index.html" }));
app.get("/office-8bit/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/dist-8bit-office"),
}));

// Serve War Room (Bevy WASM)
app.get("/war-room", serveStatic({ root: "./dist-war-room", path: "/index.html" }));
app.get("/war-room/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/war-room/, "/dist-war-room"),
}));

// Serve Race Track (Bevy WASM)
app.get("/race-track", serveStatic({ root: "./dist-race-track", path: "/index.html" }));
app.get("/race-track/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/race-track/, "/dist-race-track"),
}));

// Serve Superman Universe (Bevy WASM)
app.get("/superman", serveStatic({ root: "./dist-superman", path: "/index.html" }));
app.get("/superman/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/superman/, "/dist-superman"),
}));

// Oracle v2 proxy — search, stats
const ORACLE_URL = process.env.ORACLE_URL || "http://localhost:47779";

app.get("/api/oracle/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const params = new URLSearchParams({ q, mode: c.req.query("mode") || "hybrid", limit: c.req.query("limit") || "10" });
  const model = c.req.query("model");
  if (model) params.set("model", model);
  try {
    const res = await fetch(`${ORACLE_URL}/api/search?${params}`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

app.get("/api/oracle/traces", async (c) => {
  const limit = c.req.query("limit") || "10";
  try {
    const res = await fetch(`${ORACLE_URL}/api/traces?limit=${limit}`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

app.get("/api/oracle/stats", async (c) => {
  try {
    const res = await fetch(`${ORACLE_URL}/api/stats`);
    return c.json(await res.json());
  } catch (e: any) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});

// --- Oracle Feed ---
const feedTailer = new FeedTailer();

app.get("/api/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const oracle = c.req.query("oracle") || undefined;
  let events = feedTailer.getRecent(limit);
  if (oracle) events = events.filter(e => e.oracle === oracle);
  const active = [...feedTailer.getActive().keys()];
  return c.json({ events: events.reverse(), total: events.length, active_oracles: active });
});

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- WebSocket + Server ---

type WSData = { target: string | null; previewTargets: Set<string> };

const clients = new Set<ServerWebSocket<WSData>>();

// Push capture to a specific client (only if changed)
const lastContent = new Map<ServerWebSocket<WSData>, string>();

async function pushCapture(ws: ServerWebSocket<WSData>) {
  if (!ws.data.target) return;
  try {
    const content = await capture(ws.data.target, 80);
    const prev = lastContent.get(ws);
    if (content !== prev) {
      lastContent.set(ws, content);
      ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
    }
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

// Preview capture: lightweight 3-line captures for visible agents
const lastPreviews = new Map<ServerWebSocket<WSData>, Map<string, string>>();

async function pushPreviews(ws: ServerWebSocket<WSData>) {
  const targets = ws.data.previewTargets;
  if (!targets || targets.size === 0) return;
  const prevMap = lastPreviews.get(ws) || new Map<string, string>();
  const changed: Record<string, string> = {};
  let hasChanges = false;

  await Promise.allSettled([...targets].map(async (target) => {
    try {
      const content = await capture(target, 3);
      const prev = prevMap.get(target);
      if (content !== prev) {
        prevMap.set(target, content);
        changed[target] = content;
        hasChanges = true;
      }
    } catch {}
  }));

  lastPreviews.set(ws, prevMap);
  if (hasChanges) {
    ws.send(JSON.stringify({ type: "previews", data: changed }));
  }
}

// --- Server-side recently active tracking ---
interface RecentAgent {
  target: string;
  name: string;
  session: string;
  lastBusy: number;
}

const BUSY_PATTERNS = /[∴✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]|● \w+\(|\b(Read|Edit|Write|Bash|Grep|Glob|Agent)\b/;
const RECENT_TTL = 30 * 60 * 1000; // 30 minutes
const recentAgents = new Map<string, RecentAgent>(); // target → entry

function pruneRecent() {
  const cutoff = Date.now() - RECENT_TTL;
  for (const [k, v] of recentAgents) {
    if (v.lastBusy < cutoff) recentAgents.delete(k);
  }
}

function getRecentList(): RecentAgent[] {
  pruneRecent();
  return [...recentAgents.values()]
    .sort((a, b) => b.lastBusy - a.lastBusy)
    .slice(0, 10);
}

// Check all agents for busy status and update recentAgents
async function updateRecentFromSessions(sessions: { name: string; windows: { index: number; name: string; active: boolean }[] }[]) {
  const now = Date.now();
  const checks: Promise<void>[] = [];

  for (const s of sessions) {
    for (const w of s.windows) {
      const target = `${s.name}:${w.name}`;
      checks.push(
        capture(target, 5).then(content => {
          const lines = content.split("\n").filter(l => l.trim());
          const bottom = lines.slice(-5).join("\n");
          if (BUSY_PATTERNS.test(bottom)) {
            recentAgents.set(target, { target, name: w.name, session: s.name, lastBusy: now });
          }
        }).catch(() => {})
      );
    }
  }
  await Promise.allSettled(checks);
}

// Broadcast sessions to all clients (diff-only: skip if unchanged)
let lastSessionsJson = "";
async function broadcastSessions() {
  if (clients.size === 0) return;
  try {
    const sessions = await listSessions();
    const json = JSON.stringify(sessions);

    // Update recent tracking (runs every session poll)
    await updateRecentFromSessions(sessions);
    // Broadcast recent list to all clients
    const recentMsg = JSON.stringify({ type: "recent", agents: getRecentList() });
    for (const ws of clients) ws.send(recentMsg);

    if (json === lastSessionsJson) return;
    lastSessionsJson = json;
    const msg = JSON.stringify({ type: "sessions", sessions });
    for (const ws of clients) ws.send(msg);
  } catch {}
}

// Capture loop — push to each subscribed client
let captureInterval: ReturnType<typeof setInterval> | null = null;
let sessionInterval: ReturnType<typeof setInterval> | null = null;
let previewInterval: ReturnType<typeof setInterval> | null = null;

// Feed broadcast: emit events to all clients in real-time
let feedUnsub: (() => void) | null = null;

function startIntervals() {
  if (captureInterval) return;
  // Capture every 50ms for real-time feel (full terminal, single subscribed target)
  captureInterval = setInterval(() => {
    for (const ws of clients) pushCapture(ws);
  }, 50);
  // Sessions every 5s
  sessionInterval = setInterval(broadcastSessions, 5000);
  // Previews every 2s (lightweight 3-line captures for visible agents)
  previewInterval = setInterval(() => {
    for (const ws of clients) pushPreviews(ws);
  }, 2000);
  // Feed tailer
  feedTailer.start();
  feedUnsub = feedTailer.onEvent((event) => {
    const msg = JSON.stringify({ type: "feed", event });
    for (const ws of clients) ws.send(msg);
  });
}

function stopIntervals() {
  if (clients.size > 0) return;
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (sessionInterval) { clearInterval(sessionInterval); sessionInterval = null; }
  if (previewInterval) { clearInterval(previewInterval); previewInterval = null; }
  if (feedUnsub) { feedUnsub(); feedUnsub = null; }
  feedTailer.stop();
}

export function startServer(port = +(process.env.MAW_PORT || 3456)) {

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      // Upgrade WebSocket
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { target: null, previewTargets: new Set() } })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws: ServerWebSocket<WSData>) {
        clients.add(ws);
        startIntervals();
        // Send sessions + recent + feed history immediately
        listSessions().then(s => {
          ws.send(JSON.stringify({ type: "sessions", sessions: s }));
          ws.send(JSON.stringify({ type: "recent", agents: getRecentList() }));
        }).catch(() => {});
        ws.send(JSON.stringify({ type: "feed-history", events: feedTailer.getRecent(50) }));
      },
      message(ws: ServerWebSocket<WSData>, msg) {
        try {
          const data = JSON.parse(msg as string);
          if (data.type === "subscribe") {
            ws.data.target = data.target;
            pushCapture(ws); // immediate first push
          } else if (data.type === "subscribe-previews") {
            ws.data.previewTargets = new Set(data.targets || []);
            pushPreviews(ws); // immediate first push
          } else if (data.type === "select") {
            selectWindow(data.target).catch(() => {});
          } else if (data.type === "send") {
            sendKeys(data.target, data.text)
              .then(() => {
                ws.send(JSON.stringify({ type: "sent", ok: true, target: data.target, text: data.text }));
                // Push capture after short delay to show result
                setTimeout(() => pushCapture(ws), 300);
              })
              .catch(e => ws.send(JSON.stringify({ type: "error", error: e.message })));
          }
        } catch {}
      },
      close(ws: ServerWebSocket<WSData>) {
        clients.delete(ws);
        lastContent.delete(ws);
        lastPreviews.delete(ws);
        stopIntervals();
      },
    },
  });

  console.log(`maw serve → http://localhost:${port} (ws://localhost:${port}/ws)`);
  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
