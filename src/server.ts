import { Hono } from "hono";
import { cors } from "hono/cors";
import { MawEngine } from "./engine";
import type { WSData } from "./types";
import { loadConfig } from "./config";
import { existsSync, readFileSync } from "fs";
import { api } from "./api";
import { feedBuffer, feedListeners } from "./api/feed";
import { mountViews } from "./views/index";
import { setupTriggerListener } from "./trigger-listener";
import { createTransportRouter } from "./transports";
import { handlePtyMessage, handlePtyClose } from "./pty";

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

// Fleet topology visualization
app.get("/topology", async (c) => {
  const path = require("path").resolve(process.cwd(), "ψ/outbox/fleet-topology.html");
  try {
    const html = require("fs").readFileSync(path, "utf-8");
    return c.html(html);
  } catch { return c.text("fleet-topology.html not found", 404); }
});

mountViews(app);

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- Server ---

export async function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedBuffer, feedListeners });

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

  // Plugin system — built-in + user plugins
  try {
    const { PluginSystem, loadPlugins, reloadUserPlugins, watchUserPlugins } = require("./plugins");
    const { homedir } = require("os");
    const { join, resolve, dirname } = require("path");
    const plugins = new PluginSystem();

    // Built-in plugins (ship with maw-js)
    const builtinDir = resolve(dirname(new URL(import.meta.url).pathname), "plugins", "builtin");
    await loadPlugins(plugins, builtinDir, "builtin");

    // User plugins (file-drop: ~/.oracle/plugins/)
    const userPluginsDir = join(homedir(), ".oracle", "plugins");
    await loadPlugins(plugins, userPluginsDir, "user");

    // Hot-reload: watch the user plugins dir and re-import on .ts/.js/.wasm
    // change. Builtin plugins are not touched. Opt out with MAW_HOT_RELOAD=0.
    watchUserPlugins(userPluginsDir, async (changedFile: string) => {
      console.log(`[plugin] reloading user plugins (${changedFile} changed)`);
      await reloadUserPlugins(plugins, userPluginsDir);
    });

    // Single feedListener wires everything through the plugin pipeline
    feedListeners.add((event) => plugins.emit(event));

    // Plugin debug API + page
    app.get("/api/plugins", (c) => c.json(plugins.stats()));
    app.post("/api/plugins/reload", async (c) => {
      await reloadUserPlugins(plugins, userPluginsDir);
      return c.json({ ok: true, ...plugins.stats() });
    });
    const { pluginsView } = require("./views/plugins");
    app.route("/plugins", pluginsView(plugins));
  } catch (err) {
    console.error("[plugins] failed to init:", err);
  }

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
  // Security: bind to localhost unless peers are configured (federation needs network access)
  const config = loadConfig();
  const hasPeers = (config.peers?.length ?? 0) > 0 || (config.namedPeers?.length ?? 0) > 0;
  const hostname = hasPeers ? "0.0.0.0" : "127.0.0.1";

  if (hasPeers && !config.federationToken) {
    console.warn(`\x1b[31m⚠ WARNING: peers configured but no federationToken set!\x1b[0m`);
    console.warn(`\x1b[31m  Port ${port} is exposed to network WITHOUT authentication.\x1b[0m`);
    console.warn(`\x1b[31m  Add "federationToken" (min 16 chars) to maw.config.json\x1b[0m`);
  }

  const server = Bun.serve({ port, hostname, fetch: fetchHandler, websocket: wsHandler });
  console.log(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL}) [${hostname}]`);

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
