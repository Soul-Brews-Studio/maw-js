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

// Origin allowlist for /api/*. This is a justified divergence from the
// Soul-Brews-Studio/maw-js upstream, which still ships with `cors()` default-*.
// The evilelfza fork runs on a single-user dev machine with sensitive tokens
// (~/.claude.json, GitHub auth, etc.), so a browser-CSRF vector is materially
// more dangerous than in Nat's multi-agent open-source threat model. After
// e5007e3 removed the ORACLE_SEND_TARGETS whitelist, any tmux window —
// including bash/zsh/vim/tailers — is a valid /api/send target, which turned
// CSRF into a plausible path to RCE (Warden Round 4 NEW-8 HIGH).
//
// Requests without an Origin header (curl, Oracle reply-ping, local shell)
// are allowed through unchanged — that is what keeps the reply-ping protocol
// working. Browser requests from unknown origins are rejected both at the
// CORS layer (no `Access-Control-Allow-Origin` returned) and server-side
// via an explicit 403 (belt-and-suspenders, closes simple-request bypass).
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3456",
  "http://127.0.0.1:3456",
  "http://localhost:3457",   // maw-ui vite dev server
  "http://127.0.0.1:3457",
  // :4177 (vite preview) entries were removed as part of the Warden R7
  // housekeeping sweep. Nothing binds :4177 on the live host after the
  // ghq duplicate tree cleanup, so the allowlist entry was unused
  // attack surface. Re-add via a focused commit if `vite preview` is
  // ever brought online alongside the dev server on :3457.
]);

const app = new Hono();

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});

app.use("/api/*", cors({
  origin: (origin) => {
    // No Origin header → curl / Oracle reply-ping / local shell. Allow.
    // Returning empty string omits Access-Control-Allow-Origin from the
    // response, which is correct for non-browser callers that don't need it.
    if (!origin) return "";
    // Known-good browser origin from the developer's own maw-ui
    if (ALLOWED_ORIGINS.has(origin)) return origin;
    // Everything else: deny at the CORS layer (no ACAO header emitted).
    return null;
  },
  credentials: false,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Maw-Signature", "X-Maw-Timestamp"],
}));

// Server-side Origin enforcement — belt-and-suspenders layer. The CORS
// middleware above only controls browser-visible response headers, which a
// non-CORS "simple request" (e.g. form POST with text/plain) can bypass
// client-side. For state-changing methods we additionally reject the request
// server-side with 403 whenever the Origin header is present but not in
// ALLOWED_ORIGINS. Requests without an Origin header still pass — curl and
// every intra-Oracle reply-ping fall into that bucket.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    const origin = c.req.header("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: "cross-origin request blocked", origin }, 403);
    }
  }
  await next();
});

app.route("/api", api);

mountViews(app);

app.onError((err, c) => c.json({ error: err.message }, 500));

export { app };

// --- Server ---

export function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
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

  // MQTT bridge — publish feed events to MQTT topics (if broker configured)
  try {
    const { startMqttBridge } = require("./engine/mqtt-bridge");
    startMqttBridge(feedListeners, feedBuffer);
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

  // HTTP server (always) — bind to loopback so the entire LAN attack surface is gone.
  // Cross-device access must be added deliberately via SSH tunnel or reverse proxy.
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: fetchHandler, websocket: wsHandler });
  console.log(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL})`);

  // HTTPS server (if TLS configured)
  const tlsCfg = loadConfig().tls;
  if (tlsCfg?.cert && tlsCfg?.key && existsSync(tlsCfg.cert) && existsSync(tlsCfg.key)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(tlsCfg.cert), key: readFileSync(tlsCfg.key) };
    Bun.serve({ hostname: "127.0.0.1", port: tlsPort, tls, fetch: fetchHandler, websocket: wsHandler });
    console.log(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
