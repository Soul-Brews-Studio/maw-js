import { MawEngine } from "../engine";
import { loadConfig, cfgInterval, cfgTimeout } from "../config";
import { existsSync, readFileSync } from "fs";
import { api } from "../api";
import { feedBuffer, feedListeners } from "../api/feed";
import { setupTriggerListener } from "./runtime/trigger-listener";
import { createTransportRouter } from "../transports";
import { listSessions } from "./transport/ssh";
import { Tmux } from "./transport/tmux";
import { sweepOrphanPtySessions } from "./transport/pty";
import { isProtected, setBunServer } from "../lib/elysia-auth";
import { runServeLifecycleHooks } from "../plugin/lifecycle";
import { discoverLocalPluginDirs } from "../plugin/registry-helpers";
import {
  dispatchEnginePluginEvent,
  findEnginePluginRegistration,
  hasEnginePluginEventSink,
  proxyEnginePluginRequest,
  startEnginePluginHealthPolling,
} from "./engine-plugin-registry";
import { mawDataPath } from "./xdg";
import { UserError } from "./util/user-error";
import { startDispatchEngine } from "./dispatch-engine";
import { sendKeys } from "./transport/ssh";
import { messageQueue } from "./message-queue";
import { requestReplyStore } from "./request-reply";
import { agentStatusStore } from "./agent-status";
import { getRuntimeVersionLabel } from "./runtime/build-info";
import { ServeRouteRegistry } from "./serve-route-registry";
import { ServeWsRegistry } from "./serve-ws-registry";

// --- Version info (computed once at startup) ---

export const VERSION = getRuntimeVersionLabel();

export type ServeVerbosity = 0 | 1 | 2;
export type StartServerOptions = {
  /** 0=quiet (errors only), 1=normal, 2=verbose debug */
  verbosity?: ServeVerbosity;
};

type ServeLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function normalizeServeVerbosity(value: unknown): ServeVerbosity {
  if (value === 0 || value === "0" || value === "quiet") return 0;
  if (value === 2 || value === "2" || value === "verbose") return 2;
  return 1;
}

export function createServeLogger(verbosity: ServeVerbosity): ServeLogger {
  return {
    info: (...args: unknown[]) => { if (verbosity >= 1) console.log(...args); },
    warn: (...args: unknown[]) => { if (verbosity >= 1) console.warn(...args); },
    debug: (...args: unknown[]) => { if (verbosity >= 2) console.log(...args); },
    error: (...args: unknown[]) => { console.error(...args); },
  };
}

export function isAddressInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; syscall?: unknown; message?: unknown };
  return e.code === "EADDRINUSE"
    || (e.syscall === "listen" && typeof e.message === "string" && /port .*in use|address.*in use|EADDRINUSE/i.test(e.message));
}

export function servePortInUseInstructions(port: number, hostname: string): string[] {
  const bind = hostname === "0.0.0.0" ? `port ${port}` : `${hostname}:${port}`;
  return [
    `\x1b[31m✗\x1b[0m maw serve cannot start: ${bind} is already in use.`,
    "  likely: another maw server, pm2 process, or dev server is already listening.",
    "  check:  \x1b[36mmaw serve status\x1b[0m",
    "  stop:   \x1b[36mmaw serve stop\x1b[0m",
    `  find:   \x1b[36mlsof -nP -iTCP:${port} -sTCP:LISTEN\x1b[0m`,
    "  pm2:    \x1b[36mpm2 status maw\x1b[0m",
    "  force:  \x1b[36mmaw serve --force-takeover\x1b[0m  \x1b[90m(kills only the recorded maw PID)\x1b[0m",
    `  alt:    \x1b[36mmaw serve ${port + 1}\x1b[0m`,
  ];
}

// Bind heuristic lives in ./bind-host.ts so tests can import it without
// pulling in server.ts's module-level auto-start side effects.
import { resolveBindHost } from "./bind-host";

const serveViewsPlugin = await import(`../vendor/mpr-plugins/serve-views/index.ts?server=${encodeURIComponent(import.meta.url)}`);
const registerServeViews = serveViewsPlugin.serve;
export const createViews = serveViewsPlugin.createViews;
export const views = serveViewsPlugin.createViews();

const serveWsPlugin = await import(`../vendor/mpr-plugins/serve-ws/index.ts?server=${encodeURIComponent(import.meta.url)}`);
const registerServeWs = serveWsPlugin.serve;

const startupPeerWarningsLogged = new Set<string>();

function warnMissingFederationTokenOnce(port: number, log = createServeLogger(1)): void {
  const key = "missing-federation-token";
  if (startupPeerWarningsLogged.has(key)) return;
  startupPeerWarningsLogged.add(key);
  log.warn(`\x1b[31m⚠ WARNING: peers configured but no federationToken set!\x1b[0m`);
  log.warn(`\x1b[31m  Port ${port} is exposed to network WITHOUT authentication.\x1b[0m`);
  log.warn(`\x1b[31m  Add "federationToken" (min 16 chars) to maw.config.json\x1b[0m`);
}

// --- Server ---

export async function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456), options: StartServerOptions = {}) {
  const verbosity = options.verbosity ?? normalizeServeVerbosity(process.env.MAW_SERVE_VERBOSITY);
  const log = createServeLogger(verbosity);
  const engine = new MawEngine({ feedBuffer, feedListeners });
  const serveRoutes = new ServeRouteRegistry();
  const serveWs = new ServeWsRegistry();
  const serveViews = createViews();
  await registerServeViews({
    http: serveRoutes,
    plugin: { name: "serve-views" },
  }, { views: serveViews });
  registerServeWs({
    ws: serveWs,
    engine,
    plugin: { name: "serve-ws" },
  });

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
        log.info(`[startup] reaped orphan: ${s.name}`);
      }
      log.info(`[startup] cleaned ${stale.length} orphaned sessions`);
    }
  } catch { /* tmux may not be running */ }

  // Connect transport router (non-blocking — server starts even if transports fail)
  try {
    const router = createTransportRouter();
    router.connectAll().catch(err => log.error("[transport] connect failed:", err));
    engine.setTransportRouter(router);
  } catch (err) {
    log.error("[transport] router init failed:", err);
  }

  // Start dispatch engine — auto-delivers queued messages when agents become idle
  startDispatchEngine(sendKeys);

  // Hook workflow triggers into feed events
  setupTriggerListener(feedListeners);
  feedListeners.add((event) => {
    dispatchEnginePluginEvent(event).catch((err) => {
      log.warn(`[engine-plugin] event dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  let serveLifecyclePlugins: unknown;
  let serveLifecycleReloadPlugins: (() => Promise<unknown>) | undefined;

  // Plugin system — built-in + user plugins
  try {
    const { PluginSystem, loadPlugins, reloadUserPlugins, watchUserPlugins, registerManifestHooks } = require("../plugins/index");
    const { resolve, dirname } = require("path");
    const plugins = new PluginSystem({
      shouldSkipHandler: (eventName: string, pluginName: string | undefined) =>
        hasEnginePluginEventSink(pluginName, eventName),
    });
    serveLifecyclePlugins = plugins;

    // Built-in plugins (ship with maw-js)
    const builtinDir = resolve(dirname(new URL(import.meta.url).pathname), "plugins", "builtin");
    await loadPlugins(plugins, builtinDir, "builtin");

    // User plugins (file-drop: XDG data plugin dir; overridable for tests/dev)
    const userPluginsDir = process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
    serveLifecycleReloadPlugins = async () => {
      await reloadUserPlugins(plugins, userPluginsDir);
      return { ok: true, ...plugins.stats() };
    };
    await loadPlugins(plugins, userPluginsDir, "user");

    // Project-local plugins (.maw/plugins in cwd ancestors) are loaded after
    // user plugins so repository-specific hooks can participate in serve.
    const projectPluginDirs = discoverLocalPluginDirs(process.cwd());
    log.debug(`[serve:debug] plugins builtin=${builtinDir} user=${userPluginsDir} project=${projectPluginDirs.length}`);
    for (const dir of projectPluginDirs) {
      await loadPlugins(plugins, dir, "project");
    }

    // Package plugin hooks (manifest.hooks) — lets bundled/MPR plugins
    // subscribe to feed events without direct core imports (#1566).
    await registerManifestHooks(plugins);

    // Hot-reload: watch user and project-local plugin dirs and re-import on
    // .ts/.js/.wasm change. Builtin plugins are not touched. Opt out with
    // MAW_HOT_RELOAD=0.
    watchUserPlugins(userPluginsDir, async (changedFile: string) => {
      log.info(`[plugin] reloading user plugins (${changedFile} changed)`);
      await reloadUserPlugins(plugins, userPluginsDir);
    });
    for (const dir of projectPluginDirs) {
      watchUserPlugins(dir, async (changedFile: string) => {
        log.info(`[plugin] reloading project plugins (${changedFile} changed)`);
        plugins.unloadScope("project");
        for (const projectDir of projectPluginDirs) {
          await loadPlugins(plugins, projectDir, "project", true);
        }
        plugins._markReloaded?.();
      });
    }

    // Single feedListener wires everything through the plugin pipeline
    feedListeners.add((event) => plugins.emit(event));

  } catch (err) {
    log.error("[plugins] failed to init:", err);
  }

  const corsHeaders = (req: Request) => {
    const origin = req.headers.get("origin") ?? "*";
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Federation-Token, X-From-Signature",
      "Access-Control-Allow-Private-Network": "true",
    };
  };

  const fetchHandler = async (req: Request, server: any) => {
    const url = new URL(req.url);
    const apiPath = url.pathname.replace(/^\/api/, "");

    // CORS preflight for all routes
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    const wsUpgrade = serveWs.handleUpgrade(req, server);
    if (wsUpgrade.matched) return wsUpgrade.response;
    // Elysia handles all /api/* routes (has its own CORS)
    if (url.pathname.startsWith("/api")) {
      const enginePlugin = findEnginePluginRegistration(url.pathname);
      if (enginePlugin) return proxyEnginePluginRequest(req, enginePlugin);
      if (isProtected(apiPath, req.method)) {
        const authOrLegacyRoute = await api.handle(req.clone());
        if (authOrLegacyRoute.status !== 404) return authOrLegacyRoute;
      }
      const servedByPlugin = await serveRoutes.handle(req);
      if (servedByPlugin) return servedByPlugin;
      return api.handle(req);
    }
    const servedByPlugin = await serveRoutes.handle(req);
    if (servedByPlugin) return servedByPlugin;

    // Plugin-registered fallbacks handle views + static — clone response with CORS headers
    const addCors = (r: Response) => {
      const h = corsHeaders(req);
      return new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: { ...Object.fromEntries(r.headers.entries()), ...h },
      });
    };
    const res = serveRoutes.handleFallback(req, { server });
    if (res instanceof Promise) return res.then(addCors);
    return addCors(res as Response);
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
  log.debug(`[serve:debug] verbosity=${verbosity} port=${port} hostname=${hostname} reason=${reason ?? "explicit-local"}`);
  log.debug(`[serve:debug] peers=${hasPeers ? "configured" : "none"} tls=${config.tls?.cert && config.tls?.key ? "configured" : "off"}`);

  if (hasPeers && !config.federationToken) {
    warnMissingFederationTokenOnce(port, log);
  }

  // Duplicate <oracle>:<node> warn (#804 Step 3, ADR docs/federation/0001-peer-identity.md).
  // Boot-time scan of the peer cache + the local identity. Non-blocking — per
  // the ADR, "Crypto solves can't-fake; doctor + boot-time check solves
  // operator confusion" — so we just warn loudly and let serve continue.
  try {
    const { loadPeers } = require("../lib/peers/store");
    const { warnDuplicatesAtBoot } = require("../lib/peers/duplicate-detect");
    const peers = loadPeers().peers;
    const local = config.node ? { oracle: config.oracle ?? "mawjs", node: config.node } : undefined;
    warnDuplicatesAtBoot({ peers, local, log: (message: string) => log.warn(message) });
  } catch (e: any) {
    // Never fail boot on a dedup-scan glitch — log and move on.
    log.warn(`[startup] peer dedup scan skipped: ${e?.message || e}`);
  }

  // P1 heartbeat-reaper: Bun-managed ws ping/pong + idle close. Dead clients
  // (ungraceful disconnect, no TCP FIN) close after wsIdleSec → close handler
  // fires → handlePtyClose → detach → grace-timer reaps the maw-pty- tmux session.
  // sendPings: true is Bun's default but pinned for explicitness. Shared across
  // the HTTP + TLS Bun.serve calls below so both ws surfaces get the heartbeat.
  const wsConfig = { ...serveWs.handlers, idleTimeout: cfgTimeout("wsIdleSec"), sendPings: true };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port, hostname, fetch: fetchHandler, websocket: wsConfig });
  } catch (err) {
    if (isAddressInUseError(err)) {
      for (const line of servePortInUseInstructions(port, hostname)) log.error(line);
      throw new UserError(`maw serve port ${port} is already in use`);
    }
    throw err;
  }
  setBunServer(server);
  startEnginePluginHealthPolling();

  // #P2 — periodic orphan-PTY sweep. The boot reaper above (#300) clears the
  // server-restart class once at startup; this catches in-memory/tmux drift on
  // a long-lived process. unref() so it never holds the event loop open.
  const ptySweepTimer = setInterval(() => {
    sweepOrphanPtySessions()
      .then(({ killed, checked }) => {
        if (killed.length > 0) {
          log.info(`[pty-sweep] killed ${killed.length} orphan(s): ${killed.join(", ")} (checked ${checked})`);
        }
      })
      .catch((err) => log.error("[pty-sweep] failed:", err));
  }, cfgInterval("ptySweep"));
  (ptySweepTimer as { unref?: () => void }).unref?.();

  // #2165: maw serve is a multi-day process; keep in-memory queues/request
  // reply records/status cache bounded. The stores already expose pruning for
  // completed messages and expired request/reply entries, but serve never
  // called them, so active federation traffic could retain old objects until
  // process restart. Pending queues are preserved; only completed/expired/stale
  // terminal state is removed.
  const memoryMaintenanceTimer = setInterval(() => {
    try { messageQueue.prune(); } catch { /* best effort */ }
    try { requestReplyStore.prune(); } catch { /* best effort */ }
    try { agentStatusStore.prune(); } catch { /* best effort */ }
  }, 60_000);
  (memoryMaintenanceTimer as { unref?: () => void }).unref?.();

  const bindNote = reason ? ` (${reason})` : "";
  log.info(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL}) [${hostname}]${bindNote}`);

  log.debug(`[serve:debug] running serve lifecycle hooks`);
  try {
    await runServeLifecycleHooks({
      port,
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      hostname,
      http: serveRoutes,
      ws: serveWs,
      engine,
      plugins: serveLifecyclePlugins,
      reloadPlugins: serveLifecycleReloadPlugins,
    }, undefined, {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
    });
  } catch (err) {
    try { server.stop(true); } catch { /* best effort */ }
    throw err;
  }

  // HTTPS server (if TLS configured)
  const tlsCfg = loadConfig().tls;
  if (tlsCfg?.cert && tlsCfg?.key && existsSync(tlsCfg.cert) && existsSync(tlsCfg.key)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(tlsCfg.cert), key: readFileSync(tlsCfg.key) };
    Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsConfig });
    log.info(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
