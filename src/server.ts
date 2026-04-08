import { Hono } from "hono";
import { cors } from "hono/cors";
import { MawEngine } from "./engine";
import type { WSData } from "./types";
import { loadConfig } from "./config";
import { existsSync, readFileSync } from "fs";
import { api } from "./api";
import { feedBuffer, feedListeners } from "./api/feed";
import { mawLogListeners } from "./api/maw-log";
import { mountViews } from "./views/index";
import { setupTriggerListener } from "./trigger-listener";
import { createTransportRouter } from "./transports";
import { handlePtyMessage, handlePtyClose } from "./pty";
import { initDb } from "./db";
import { attachSink } from "./db/sink";

// --- Version info (computed once at startup) ---

function getVersionString(): string {
  try {
    const pkg = require("../package.json");
    let hash = ""; try { hash = require("child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim(); } catch {}
    let buildDate = "";
    try {
      const raw = require("child_process").execSync("git log -1 --format=%ci", { cwd: import.meta.dir }).toString().trim();
      const d = new Date(raw);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      buildDate = `${raw.slice(0, 10)} ${days[d.getDay()]} ${raw.slice(11, 16)}`;
    } catch {}
    return `v${pkg.version}${hash ? ` (${hash})` : ""}${buildDate ? ` built ${buildDate}` : ""}`;
  } catch { return ""; }
}

export const VERSION = getVersionString();

// --- Hono app ---

const app = new Hono();
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.use("/api/*", cors());

app.route("/api", api);

mountViews(app);

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- Server ---

export function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedBuffer, feedListeners, mawLogListeners });

  // Initialize SQLite persistence (non-blocking — server starts even if DB fails)
  initDb()
    .then(() => attachSink(feedListeners))
    .catch((err) => console.error("[db] init failed (continuing without persistence):", err));

  const HTTP_URL = `http://localhost:${port}`;
  const WS_URL = `ws://localhost:${port}/ws`;

  // Connect transport router (non-blocking — server starts even if transports fail)
  try {
    const router = createTransportRouter();
    router.connectAll().catch(err => console.error("[transport] connect failed:", err));
    engine.setTransportRouter(router);
  } catch (err) {
    console.error("[transport] router init failed:", err);
  }

  // Hook workflow triggers into feed events
  setupTriggerListener(feedListeners);

  // MQTT bridge — publish feed events to MQTT topics (if broker configured)
  try {
    const { startMqttBridge } = require("./engine/mqtt-bridge");
    startMqttBridge(feedListeners, feedBuffer);
  } catch {}

  // Health escalation chain — multi-level alerts (Discord → LINE → repeat)
  try {
    const { initEscalation } = require("./engine/escalation");
    const chain = initEscalation({
      lineToken: process.env.LINE_NOTIFY_TOKEN,
      repeatMinutes: 10,
    });
    // Wire Discord as L1 handler (reuse webhook format)
    const webhookUrl = process.env.PULSE_WEBHOOK_URL;
    if (webhookUrl) {
      chain.setDiscordHandler(async (_metrics: any, reason: string) => {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🚨 **Health Alert**`,
            embeds: [{
              color: 0xff4444,
              title: "Escalation Alert",
              description: reason,
              timestamp: new Date().toISOString(),
              footer: { text: "MAW Escalation Chain" },
            }],
          }),
        }).catch(() => {});
      });
    }
  } catch (e) {
    console.error("[escalation] init failed:", e);
  }

  // Discord bridge — forward chat + deploy events to Discord webhook
  try {
    const { startDiscordBridge } = require("./engine/discord-bridge");
    startDiscordBridge(mawLogListeners, feedListeners);
  } catch {}

  // Discord bot — bidirectional Oracle↔Discord communication
  try {
    const { startDiscordBot } = require("./engine/discord-bot");
    startDiscordBot(mawLogListeners, feedListeners);
  } catch {}


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
    return app.fetch(req, { server });
  };

  // HTTP server (always)
  const server = Bun.serve({ port, fetch: fetchHandler, websocket: wsHandler });
  console.log(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL})`);

  // HTTPS server (if TLS configured)
  const tlsCfg = loadConfig().tls;
  if (tlsCfg?.cert && tlsCfg?.key && existsSync(tlsCfg.cert) && existsSync(tlsCfg.key)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(tlsCfg.cert), key: readFileSync(tlsCfg.key) };
    Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsHandler });
    console.log(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
