import { Hono } from "hono";
import { MawEngine } from "../engine";
import type { WSData } from "./types";
import { loadConfig } from "../config";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { serveStatic } from "hono/bun";
import { api } from "../api";
import { feedBuffer, feedListeners } from "../api/feed";
import { mountViews } from "../views/index";
import { setupTriggerListener } from "./runtime/trigger-listener";
import { createTransportRouter } from "../transports";
import { listSessions } from "./transport/ssh";
import { Tmux } from "./transport/tmux";
import { handlePtyMessage, handlePtyClose } from "./transport/pty";
import { setBunServer } from "../lib/elysia-auth";

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

// Bind heuristic lives in ./bind-host.ts so tests can import it without
// pulling in server.ts's module-level auto-start side effects.
import { resolveBindHost } from "./bind-host";

// --- Views + static (Hono keeps these) ---

const views = new Hono();

// Fleet topology visualization
views.get("/topology", async (c) => {
  const path = require("path").resolve(process.cwd(), "ψ/outbox/fleet-topology.html");
  try {
    const html = require("fs").readFileSync(path, "utf-8");
    return c.html(html);
  } catch { return c.text("fleet-topology.html not found", 404); }
});

mountViews(views);

// Serve packed maw-ui dist (Shape A — single port, single process)
const MAW_UI_DIR = process.env.MAW_UI_DIR || join(homedir(), ".maw", "ui", "dist");
if (existsSync(MAW_UI_DIR)) {
  views.use("/*", serveStatic({ root: MAW_UI_DIR }));
} else {
  // The Door — minimal landing page when no packed maw-ui is installed.
  // Lets users connect to any federation by pasting an address.
  let doorHtml: string;
  try {
    doorHtml = readFileSync(join(import.meta.dir, "static", "door.html"), "utf-8");
  } catch {
    // door.html missing (e.g. fresh clone without assets) — serve inline stub
    process.stderr.write("→ maw-ui not found. Run `maw ui build` or install maw-ui.\n");
    doorHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>maw</title></head><body style="font-family:monospace;background:#0d0d0d;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#fff">maw</h1><p>maw-ui not installed. Run <code style="color:#7dd3fc">maw ui build</code> or install maw-ui.</p></div></body></html>`;
  }
  views.get("/", (c) => c.html(doorHtml));
}

views.onError((err, c) => c.json({ error: err.message }, 500));

export { views };

// --- Server ---

export async function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedBuffer, feedListeners });

  const HTTP_URL = `http://localhost:${port}`;
  const WS_URL = `ws://localhost:${port}/ws`;

  // Reap orphaned PTY + view sessions from previous server lifecycle (#300)
  try {
    const sessions = await listSessions();
    const stale = sessions.filter(s =>
      s.name.startsWith("maw-pty-") || s.name.endsWith("-view")
    );
    if (stale.length > 0) {
      const reaper = new Tmux();
      for (const s of stale) {
        await reaper.killSession(s.name);
        console.log(`[startup] reaped orphan: ${s.name}`);
      }
      console.log(`[startup] cleaned ${stale.length} orphaned sessions`);
    }
  } catch { /* tmux may not be running */ }

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
    const { PluginSystem, loadPlugins, reloadUserPlugins, watchUserPlugins } = require("../plugins/index");
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

    // Plugin debug API + page (still on Hono views — will move to Elysia in #312)
    views.get("/api/plugins", (c) => c.json(plugins.stats()));
    views.post("/api/plugins/reload", async (c) => {
      await reloadUserPlugins(plugins, userPluginsDir);
      return c.json({ ok: true, ...plugins.stats() });
    });
    const { pluginsView } = require("../views/plugins");
    views.route("/plugins", pluginsView(plugins));
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
    // Elysia handles all /api/* routes
    if (url.pathname.startsWith("/api")) {
      return api.handle(req);
    }
    // Hono handles views + static
    return views.fetch(req, { server });
  };

  // HTTP server (always)
  // Security: bind to localhost unless federation is active (see resolveBindHost).
  // #713: config.bind takes precedence over the heuristic — it's the explicit
  // "I want to listen on this address" knob, separate from config.host (the
  // outbound connection target).
  const config = loadConfig();
  const heuristic = resolveBindHost(config);
  const hostname = config.bind ?? heuristic.hostname;
  const reason = config.bind ? "config.bind" as const : heuristic.reason;
  const hasPeers = heuristic.reason !== null;

  if (hasPeers && !config.federationToken) {
    console.warn(`\x1b[31m⚠ WARNING: peers configured but no federationToken set!\x1b[0m`);
    console.warn(`\x1b[31m  Port ${port} is exposed to network WITHOUT authentication.\x1b[0m`);
    console.warn(`\x1b[31m  Add "federationToken" (min 16 chars) to maw.config.json\x1b[0m`);
  }

  // Duplicate <oracle>:<node> warn (#804 Step 3, ADR docs/federation/0001-peer-identity.md).
  // Boot-time scan of the peer cache + the local identity. Non-blocking — per
  // the ADR, "Crypto solves can't-fake; doctor + boot-time check solves
  // operator confusion" — so we just warn loudly and let serve continue.
  try {
    const { loadPeers } = require("../commands/plugins/peers/store");
    const { warnDuplicatesAtBoot } = require("../commands/plugins/peers/duplicate-detect");
    const peers = loadPeers().peers;
    const local = config.node ? { oracle: config.oracle ?? "mawjs", node: config.node } : undefined;
    warnDuplicatesAtBoot({ peers, local });
  } catch (e: any) {
    // Never fail boot on a dedup-scan glitch — log and move on.
    console.warn(`[startup] peer dedup scan skipped: ${e?.message || e}`);
  }

  const server = Bun.serve({ port, hostname, fetch: fetchHandler, websocket: wsHandler });
  setBunServer(server);
  const bindNote = reason ? ` (${reason})` : "";
  console.log(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL}) [${hostname}]${bindNote}`);

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
