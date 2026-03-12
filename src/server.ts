import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { listSessions, capture, sendKeys, selectWindow } from "./ssh";
import { processMirror } from "./overview";
import { FeedTailer } from "./feed-tail";
import { MawEngine } from "./engine";
import type { WSData } from "./types";

const app = new Hono();
app.use("/api/*", cors());

// API routes (keep for CLI compatibility)
app.get("/api/sessions", async (c) => c.json(await listSessions()));

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

// --- Fleet Config ---

const fleetDir = join(import.meta.dir, "../fleet");

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

import { handlePtyMessage, handlePtyClose } from "./pty";

export function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedTailer });

  const server = Bun.serve({
    port,
    fetch(req, server) {
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
    },
    websocket: {
      open: (ws) => {
        if (ws.data.mode === "pty") return;
        engine.handleOpen(ws);
      },
      message: (ws, msg) => {
        if (ws.data.mode === "pty") { handlePtyMessage(ws, msg); return; }
        engine.handleMessage(ws, msg);
      },
      close: (ws) => {
        if (ws.data.mode === "pty") { handlePtyClose(ws); return; }
        engine.handleClose(ws);
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
