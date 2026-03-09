import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { listSessions, capture, sendKeys, selectWindow } from "./ssh";
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

// Serve WASM office (Macroquad / Rust → WASM)
app.get("/wasm-office", serveStatic({ root: "./dist-wasm-office", path: "/index.html" }));
// Bridge version: canvas + HTML overlay with two-way WASM↔JS bridge
app.get("/wasm-office/bridge", serveStatic({ root: "./dist-wasm-office", path: "/bridge.html" }));
app.get("/wasm-office/*", serveStatic({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/wasm-office/, "/dist-wasm-office"),
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

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- WebSocket + Server ---

type WSData = { target: string | null };

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

// Broadcast sessions to all clients
async function broadcastSessions() {
  if (clients.size === 0) return;
  try {
    const sessions = await listSessions();
    const msg = JSON.stringify({ type: "sessions", sessions });
    for (const ws of clients) ws.send(msg);
  } catch {}
}

// Capture loop — push to each subscribed client
let captureInterval: ReturnType<typeof setInterval> | null = null;
let sessionInterval: ReturnType<typeof setInterval> | null = null;

function startIntervals() {
  if (captureInterval) return;
  // Capture every 50ms for real-time feel
  captureInterval = setInterval(() => {
    for (const ws of clients) pushCapture(ws);
  }, 50);
  // Sessions every 5s
  sessionInterval = setInterval(broadcastSessions, 5000);
}

function stopIntervals() {
  if (clients.size > 0) return;
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (sessionInterval) { clearInterval(sessionInterval); sessionInterval = null; }
}

export function startServer(port = +(process.env.MAW_PORT || 3456)) {

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      // Upgrade WebSocket
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { target: null } })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws: ServerWebSocket<WSData>) {
        clients.add(ws);
        startIntervals();
        // Send sessions immediately
        listSessions().then(s => ws.send(JSON.stringify({ type: "sessions", sessions: s }))).catch(() => {});
      },
      message(ws: ServerWebSocket<WSData>, msg) {
        try {
          const data = JSON.parse(msg as string);
          if (data.type === "subscribe") {
            ws.data.target = data.target;
            pushCapture(ws); // immediate first push
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
