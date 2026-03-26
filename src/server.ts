import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { dirname, resolve } from "path";

const MAW_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
import { listSessions, capture, sendKeys, selectWindow } from "./ssh";
import { getAggregatedSessions, getFederationStatus, findPeerForTarget, sendKeysToPeer } from "./peers";
import { processMirror } from "./commands/overview";
import { MawEngine } from "./engine";
import { scanTeams } from "./engine.teams";
import type { FeedEvent } from "./lib/feed";
import type { WSData } from "./types";

const app = new Hono();
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.use("/api/*", cors());

// API routes (keep for CLI compatibility)
app.get("/api/sessions", async (c) => {
  const local = await listSessions();
  const aggregated = await getAggregatedSessions(local);
  return c.json(aggregated);
});

app.get("/api/capture", async (c) => {
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target required" }, 400);
  try {
    return c.json({ content: await capture(target) });
  } catch (e: any) {
    return c.json({ content: "", error: e.message });
  }
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

  // Check if target is on a peer
  const local = await listSessions();
  const peerUrl = await findPeerForTarget(target, local);

  if (peerUrl) {
    // Route to peer
    const ok = await sendKeysToPeer(peerUrl, target, text);
    if (ok) return c.json({ ok: true, target, text, source: peerUrl });
    return c.json({ error: "Failed to send to peer", target, source: peerUrl }, 502);
  }

  // Send locally
  await sendKeys(target, text);
  return c.json({ ok: true, target, text, source: "local" });
});

app.post("/api/select", async (c) => {
  const { target } = await c.req.json();
  if (!target) return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});

// Federation status — check peer connectivity
app.get("/api/federation/status", async (c) => {
  const status = await getFederationStatus();
  return c.json(status);
});

// Serve React app from root (single entry point for all views)
app.get("/", serveStatic({ root: `${MAW_ROOT}/dist-office`, path: "/index.html" }));

// Legacy redirects — old paths → hash routes in the React app
app.get("/dashboard", (c) => c.redirect("/#orbital"));
app.get("/office", (c) => c.redirect("/#office"));

// Serve React app assets
app.get("/assets/*", serveStatic({ root: `${MAW_ROOT}/dist-office` }));

// Keep /office/* for backward compat (deep-links, bookmarks)
app.get("/office/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/office/, "/dist-office"),
}));

// Serve 8-bit office (Bevy WASM)
app.get("/office-8bit", serveStatic({ root: `${MAW_ROOT}/dist-8bit-office`, path: "/index.html" }));
app.get("/office-8bit/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/dist-8bit-office"),
}));

// Serve War Room (Bevy WASM)
app.get("/war-room", serveStatic({ root: `${MAW_ROOT}/dist-war-room`, path: "/index.html" }));
app.get("/war-room/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/war-room/, "/dist-war-room"),
}));

// Serve Race Track (Bevy WASM)
app.get("/race-track", serveStatic({ root: `${MAW_ROOT}/dist-race-track`, path: "/index.html" }));
app.get("/race-track/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/race-track/, "/dist-race-track"),
}));

// Serve Superman Universe (Bevy WASM)
app.get("/superman", serveStatic({ root: `${MAW_ROOT}/dist-superman`, path: "/index.html" }));
app.get("/superman/*", serveStatic({
  root: MAW_ROOT,
  rewriteRequestPath: (p) => p.replace(/^\/superman/, "/dist-superman"),
}));

// Oracle v2 proxy — search, stats
import { loadConfig, buildCommand, saveConfig, configForDisplay } from "./config";
const ORACLE_URL = process.env.ORACLE_URL || loadConfig().oracleUrl;

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

// --- UI State persistence (cross-device) ---
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";

const uiStatePath = join(import.meta.dir, "../ui-state.json");

app.get("/api/ui-state", (c) => {
  try {
    if (!existsSync(uiStatePath)) return c.json({});
    return c.json(JSON.parse(readFileSync(uiStatePath, "utf-8")));
  } catch {
    return c.json({});
  }
});

app.post("/api/ui-state", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync(uiStatePath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Asks persistence (inbox) ---
const asksPath = join(import.meta.dir, "../asks.json");

app.get("/api/asks", (c) => {
  try {
    if (!existsSync(asksPath)) return c.json([]);
    return c.json(JSON.parse(readFileSync(asksPath, "utf-8")));
  } catch {
    return c.json([]);
  }
});

app.post("/api/asks", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync(asksPath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Fleet Config ---

import { FLEET_DIR as fleetDir } from "./paths";

app.get("/api/fleet-config", (c) => {
  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => JSON.parse(readFileSync(join(fleetDir, f), "utf-8")));
    return c.json({ configs });
  } catch (e: any) {
    return c.json({ configs: [], error: e.message });
  }
});

// List all config files (maw.config.json + fleet/*.json + fleet/*.json.disabled)
app.get("/api/config-files", (c) => {
  const files: { name: string; path: string; enabled: boolean }[] = [
    { name: "maw.config.json", path: "maw.config.json", enabled: true },
  ];
  try {
    const entries = readdirSync(fleetDir).filter(f => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
    for (const f of entries) {
      const enabled = !f.endsWith(".disabled");
      files.push({ name: f, path: `fleet/${f}`, enabled });
    }
  } catch {}
  return c.json({ files });
});

// Read a single config file
app.get("/api/config-file", (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  try {
    const content = readFileSync(fullPath, "utf-8");
    // For maw.config.json, mask env values
    if (filePath === "maw.config.json") {
      const data = JSON.parse(content);
      const display = configForDisplay();
      data.env = display.envMasked;
      return c.json({ content: JSON.stringify(data, null, 2) });
    }
    return c.json({ content });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Save a config file
app.post("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  // Only allow maw.config.json and fleet/ files
  if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
    return c.json({ error: "invalid path" }, 403);
  }
  try {
    const { content } = await c.req.json();
    JSON.parse(content); // validate JSON
    const fullPath = join(import.meta.dir, "..", filePath);
    if (filePath === "maw.config.json") {
      // Handle masked env values
      const parsed = JSON.parse(content);
      if (parsed.env && typeof parsed.env === "object") {
        const current = loadConfig();
        for (const [k, v] of Object.entries(parsed.env as Record<string, string>)) {
          if (/\u2022/.test(v)) parsed.env[k] = current.env[k] || v;
        }
      }
      saveConfig(parsed);
    } else {
      writeFileSync(fullPath, content + "\n", "utf-8");
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Toggle enable/disable a fleet file
app.post("/api/config-file/toggle", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "invalid path" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  const isDisabled = filePath.endsWith(".disabled");
  const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
  const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
  renameSync(fullPath, newPath);
  return c.json({ ok: true, newPath: newRelPath });
});

// Delete a fleet file
app.delete("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "cannot delete" }, 400);
  const fullPath = join(import.meta.dir, "..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  unlinkSync(fullPath);
  return c.json({ ok: true });
});

// Create a new fleet file
app.put("/api/config-file", async (c) => {
  const { name, content } = await c.req.json();
  if (!name || !name.endsWith(".json")) return c.json({ error: "name must end with .json" }, 400);
  const safeName = basename(name);
  const fullPath = join(fleetDir, safeName);
  if (existsSync(fullPath)) return c.json({ error: "file already exists" }, 409);
  try { JSON.parse(content); } catch { return c.json({ error: "invalid JSON" }, 400); }
  writeFileSync(fullPath, content + "\n", "utf-8");
  return c.json({ ok: true, path: `fleet/${safeName}` });
});

// --- Config API ---
// PIN verification — pin is stored in maw.config.json as "pin" field
// Rate limit: max 5 attempts per IP per minute
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

app.get("/api/pin-info", (c) => {
  const config = loadConfig() as any;
  const pin = config.pin || "";
  return c.json({ length: pin.length, enabled: pin.length > 0 });
});

app.post("/api/pin-set", async (c) => {
  const { pin } = await c.req.json();
  const newPin = typeof pin === "string" ? pin.replace(/\D/g, "") : "";
  saveConfig({ pin: newPin } as any);
  return c.json({ ok: true, length: newPin.length, enabled: newPin.length > 0 });
});

app.post("/api/pin-verify", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "local";
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  pinAttempts.set(ip, entry);
  if (entry.count > 5) {
    return c.json({ ok: false, error: "Too many attempts. Wait 1 minute." }, 429);
  }

  const { pin } = await c.req.json();
  const config = loadConfig() as any;
  const correct = config.pin || "";
  if (!correct) return c.json({ ok: true });
  const ok = pin === correct;
  if (ok) pinAttempts.delete(ip); // reset on success
  return c.json({ ok });
});

app.get("/api/config", (c) => {
  if (c.req.query("raw") === "1") return c.json(loadConfig());
  return c.json(configForDisplay());
});

app.post("/api/config", async (c) => {
  try {
    const body = await c.req.json();
    // If env has masked values (bullet chars), keep originals for those keys
    if (body.env && typeof body.env === "object") {
      const current = loadConfig();
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env as Record<string, string>)) {
        merged[k] = /\u2022/.test(v) ? (current.env[k] || v) : v;
      }
      body.env = merged;
    }
    saveConfig(body);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Worktree Hygiene ---
import { scanWorktrees, cleanupWorktree } from "./worktrees";

app.get("/api/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/worktrees/cleanup", async (c) => {
  const { path } = await c.req.json();
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    const log = await cleanupWorktree(path);
    return c.json({ ok: true, log });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Token + maw-log APIs removed — use POST /api/feed for all events
app.get("/api/tokens", (c) => c.json({ error: "removed — use /api/feed" }, 410));
app.get("/api/tokens/rate", (c) => c.json({ totalTokens: 0, totalPerMin: 0, inputPerMin: 0, outputPerMin: 0, inputTokens: 0, outputTokens: 0, turns: 0 }));
app.get("/api/maw-log", (c) => c.json({ entries: [], total: 0 }));

// --- Oracle Feed (in-memory, HTTP push) ---
const feedBuffer: FeedEvent[] = [];
const FEED_MAX = 500;
const feedListeners = new Set<(event: FeedEvent) => void>();

function pushFeedEvent(event: FeedEvent) {
  feedBuffer.push(event);
  if (feedBuffer.length > FEED_MAX) feedBuffer.splice(0, feedBuffer.length - FEED_MAX);
  for (const fn of feedListeners) fn(event);
}

app.get("/api/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const oracle = c.req.query("oracle") || undefined;
  let events = feedBuffer.slice(-limit);
  if (oracle) events = events.filter(e => e.oracle === oracle);
  const activeMap = new Map<string, FeedEvent>();
  const cutoff = Date.now() - 5 * 60_000;
  for (const e of feedBuffer) { if (e.ts >= cutoff) activeMap.set(e.oracle, e); }
  return c.json({ events: events.reverse(), total: events.length, active_oracles: [...activeMap.keys()] });
});

app.post("/api/feed", async (c) => {
  const body = await c.req.json();
  const event: FeedEvent = {
    timestamp: body.timestamp || new Date().toISOString(),
    oracle: body.oracle || "unknown",
    host: body.host || "local",
    event: body.event || "Notification",
    project: body.project || "",
    sessionId: body.sessionId || "",
    message: body.message || "",
    ts: body.ts || Date.now(),
  };
  pushFeedEvent(event);
  return c.json({ ok: true });
});

// --- Agent Teams ---
import { homedir } from "os";

app.get("/api/teams", (c) => {
  const teams = scanTeams();
  return c.json({ teams, total: teams.length });
});

app.get("/api/teams/:name", (c) => {
  const name = c.req.param("name");
  const configPath = join(homedir(), ".claude/teams", name, "config.json");
  try { return c.json(JSON.parse(readFileSync(configPath, "utf-8"))); }
  catch { return c.json({ error: "team not found" }, 404); }
});

app.get("/api/teams/:name/tasks", (c) => {
  const name = c.req.param("name");
  const tasksDir = join(homedir(), ".claude/tasks", name);
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith(".json"));
    const tasks = files.map(f => {
      try { return JSON.parse(readFileSync(join(tasksDir, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    return c.json({ tasks, total: tasks.length });
  } catch { return c.json({ tasks: [], total: 0 }); }
});

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- WebSocket + Server ---

import { handlePtyMessage, handlePtyClose } from "./pty";

export function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedBuffer, feedListeners });

  const wsHandler = {
    open: (ws: any) => {
      if (ws.data.mode === "pty") return;
      engine.handleOpen(ws);
    },
    message: (ws: any, msg: any) => {
      if (ws.data.mode === "pty") { handlePtyMessage(ws, msg); return; }
      engine.handleMessage(ws, msg);
    },
    close: (ws: any) => {
      if (ws.data.mode === "pty") { handlePtyClose(ws); return; }
      engine.handleClose(ws);
    },
  };

  const fetchHandler = (req: Request, server: any) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws/pty") {
      if (server.upgrade(req, { data: { target: null, previewTargets: new Set(), mode: "pty" } as WSData })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { target: null, previewTargets: new Set() } as WSData })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  };

  // HTTP server (always)
  const server = Bun.serve({ port, fetch: fetchHandler, websocket: wsHandler });
  console.log(`maw serve → http://localhost:${port} (ws://localhost:${port}/ws)`);

  // HTTPS server (if mkcert certs exist)
  const certPath = join(import.meta.dir, "../white.local+3.pem");
  const keyPath = join(import.meta.dir, "../white.local+3-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsHandler });
    console.log(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
