import { MawEngine } from "../engine";
import { loadConfig, cfgTimeout } from "../config";
import { selectGateway, type GatewayKind } from "./gateway";
import { existsSync, readFileSync } from "fs";
import { api } from "../api";
import { feedBuffer, feedListeners } from "../api/feed";
import { setupTriggerListener } from "./runtime/trigger-listener";
import { createScopedTransportRouter } from "../transports";
import { isProtected, setBunServer } from "../lib/elysia-auth";
import { runServeLifecycleHooks } from "../plugin/lifecycle";
import { discoverLocalPluginDirs } from "../plugin/registry-helpers";
import {
  dispatchEnginePluginEvent,
  findEnginePluginRegistration,
  hasEnginePluginEventSink,
  proxyEnginePluginRequest,
} from "./engine-plugin-registry";
import { mawDataPath } from "./xdg";
import { UserError } from "./util/user-error";
import { startDispatchEngine } from "./dispatch-engine";
import { sendKeys } from "./transport/ssh";
import { getRuntimeVersionLabel } from "./runtime/build-info";
import { ServeRouteRegistry } from "./serve-route-registry";
import { ServeWsRegistry } from "./serve-ws-registry";
import { addCorsHeaders, handleCorsOptions } from "./serve-cors";
import { createViews } from "../vendor/mpr-plugins/serve-views/index.ts";
import { serve as registerServeWs } from "../vendor/mpr-plugins/serve-ws/index.ts";
export { createViews };

// --- Version info (computed once at startup) ---

export const VERSION = getRuntimeVersionLabel();

export type ServeVerbosity = 0 | 1 | 2 | 3 | 4;
export type ServeProfile = {
  /** Transport names to initialize. Omit for today's full transport wiring. */
  transports?: string[];
  /** Maintenance timers such as capture/session/status polling and dispatch delivery. */
  intervals?: boolean;
  /** Static/browser view fallbacks registered by the serve-views lifecycle plugin. */
  views?: boolean;
  /** API serve lifecycle modules to mount, e.g. ["identity", "triggers"]. Omit for all. */
  apiRouters?: string[];
};

export type StartServerOptions = {
  /** 0=quiet (errors only), 1=normal, 2=debug, 3=HTTP access, 4=WS frames */
  verbosity?: ServeVerbosity;
  /** Serve gateway selection (#2566): CLI > env MAW_GATEWAY > config.gateway > bun. */
  gateway?: GatewayKind;
  /** Optional serve composition profile; default preserves today's full wiring. */
  profile?: ServeProfile;
  /** Request takeover behavior for gateway implementations that can clear a bound port. */
  forceTakeover?: boolean;
};

type ServeLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  access: (...args: unknown[]) => void;
  frame: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function normalizeServeVerbosity(value: unknown): ServeVerbosity {
  if (value === "quiet") return 0;
  if (value === "normal") return 1;
  if (value === "verbose" || value === "debug") return 2;
  if (value === "access") return 3;
  if (value === "frames" || value === "frame" || value === "ws") return 4;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : null;
  if (parsed !== null && Number.isFinite(parsed)) {
    return Math.max(0, Math.min(4, Math.trunc(parsed))) as ServeVerbosity;
  }
  return 1;
}

export function createServeLogger(verbosity: ServeVerbosity): ServeLogger {
  return {
    info: (...args: unknown[]) => { if (verbosity >= 1) console.log(...args); },
    warn: (...args: unknown[]) => { if (verbosity >= 1) console.warn(...args); },
    debug: (...args: unknown[]) => { if (verbosity >= 2) console.log(...args); },
    access: (...args: unknown[]) => { if (verbosity >= 3) console.log(...args); },
    frame: (...args: unknown[]) => { if (verbosity >= 4) console.log(...args); },
    error: (...args: unknown[]) => { console.error(...args); },
  };
}

const UI_STATE_ACCESS_LOG_PATH = "/api/ui-state";
const UI_STATE_ACCESS_LOG_INTERVAL_MS = 10_000;

type UiStateAccessLogState = {
  count: number;
  windowStartedAt: number;
};

export function formatBatchedUiStateAccessLog(
  state: UiStateAccessLogState,
  input: { method: string; status: number; now: number },
): string | null {
  state.count++;
  const elapsedMs = input.now - state.windowStartedAt;
  if (elapsedMs < UI_STATE_ACCESS_LOG_INTERVAL_MS) return null;
  const count = state.count;
  const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
  state.count = 0;
  state.windowStartedAt = input.now;
  return `[serve:http] ${input.method} ${UI_STATE_ACCESS_LOG_PATH} -> ${input.status} (${count} requests/${elapsedSec}s)`;
}

function websocketRouteLabel(ws: { data?: Record<string, unknown> }): string {
  const route = ws.data?.__serveWsRoute;
  if (typeof route === "string") return route;
  const mode = ws.data?.mode;
  return typeof mode === "string" ? `/ws:${mode}` : "/ws";
}

function websocketFrameSize(message: unknown): string {
  if (typeof message === "string") return `${message.length}B`;
  if (message instanceof ArrayBuffer) return `${message.byteLength}B`;
  if (ArrayBuffer.isView(message)) return `${message.byteLength}B`;
  return "unknown-size";
}

export function isAddressInUseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; syscall?: unknown; message?: unknown };
  return e.code === "EADDRINUSE"
    || (e.syscall === "listen" && typeof e.message === "string" && /port .*in use|address.*in use|EADDRINUSE/i.test(e.message));
}

function bindTlsServerStop(primary: ReturnType<typeof Bun.serve>, tlsServer: ReturnType<typeof Bun.serve>): ReturnType<typeof Bun.serve> {
  const originalStop = primary.stop;
  primary.stop = ((closeActiveConnections?: boolean) => {
    let primaryResult: unknown;
    let primaryError: unknown;
    try {
      primaryResult = originalStop.call(primary, closeActiveConnections);
    } catch (err) {
      primaryError = err;
    }

    try {
      tlsServer.stop(closeActiveConnections);
    } catch (err) {
      if (!primaryError) primaryError = err;
    }

    if (primaryError) throw primaryError;
    return primaryResult;
  }) as typeof primary.stop;
  return primary;
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


export const SERVE_ROUTE_SNAPSHOT_SYMBOL = Symbol.for("maw.serve.routeSnapshot");

export type ServeRouteSnapshotEntry = {
  kind: "HTTP" | "WS" | "MIDDLEWARE" | "FALLBACK" | "PROXY";
  method?: string;
  path: string;
  source: string;
};

type ServeRouteSnapshotDeps = {
  http: ServeRouteRegistry;
  ws: ServeWsRegistry;
  apiRoutes?: Array<{ method?: unknown; path?: unknown }>;
};

function routeMethods(method: unknown): string[] {
  if (Array.isArray(method)) return method.map(String);
  if (typeof method === "string") return [method];
  return [String(method ?? "UNKNOWN")];
}

export function collectServeRouteSnapshot({ http, ws, apiRoutes = api.routes ?? [] }: ServeRouteSnapshotDeps): ServeRouteSnapshotEntry[] {
  const entries: ServeRouteSnapshotEntry[] = [
    { kind: "MIDDLEWARE", path: "01 *", source: "CORS preflight (handleCorsOptions)" },
    { kind: "MIDDLEWARE", path: "02 /ws*", source: "WebSocket upgrade registry before HTTP routing" },
    { kind: "PROXY", path: "/api/{engine-plugin-prefix}/*", source: "dynamic engine plugin proxy (findEnginePluginRegistration)" },
    { kind: "MIDDLEWARE", path: "03 /api protected", source: "legacy Elysia auth gate before serve plugin fallback" },
    { kind: "MIDDLEWARE", path: "04 /api", source: "serve route registry before legacy Elysia for unprotected API routes" },
    { kind: "MIDDLEWARE", path: "05 /api", source: "legacy Elysia app with @elysiajs/cors" },
    { kind: "MIDDLEWARE", path: "06 /api", source: "federationAuth HMAC" },
    { kind: "MIDDLEWARE", path: "07 /api", source: "fromSigningAuth peer signature" },
    { kind: "MIDDLEWARE", path: "08 *", source: "fallback CORS wrapper" },
  ];

  for (const route of apiRoutes) {
    const path = typeof route.path === "string" ? route.path : String(route.path ?? "");
    if (!path) continue;
    for (const method of routeMethods(route.method)) {
      entries.push({ kind: "HTTP", method: method.toUpperCase(), path, source: "elysia api" });
    }
  }

  for (const route of http.snapshot()) {
    entries.push({
      kind: "HTTP",
      method: route.method,
      path: route.path,
      source: route.plugin ? `serve plugin:${route.plugin}` : "serve route registry",
    });
  }

  for (const route of ws.snapshot()) {
    entries.push({ kind: "WS", method: "WS", path: route, source: "serve ws registry" });
  }

  for (const fallback of http.fallbackSnapshot()) {
    entries.push({
      kind: "FALLBACK",
      method: "FALLBACK",
      path: `* (${fallback.id})`,
      source: fallback.plugin ? `serve plugin:${fallback.plugin}` : "serve route registry",
    });
  }

  return entries;
}

export function formatServeRouteSnapshot(entries: ServeRouteSnapshotEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.kind === "MIDDLEWARE") return `MIDDLEWARE ${entry.path} -> ${entry.source}`;
      if (entry.kind === "PROXY") return `PROXY ${entry.path} -> ${entry.source}`;
      return `${entry.method ?? entry.kind} ${entry.path} -> ${entry.source}`;
    })
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

export const views = createViews();

export type StartServerProfileOrOptions = ServeProfile | StartServerOptions;

function looksLikeStartServerOptions(input: StartServerProfileOrOptions | undefined): input is StartServerOptions {
  return !!input && ("verbosity" in input || "profile" in input || "gateway" in input);
}

function resolveStartServerInputs(input: StartServerProfileOrOptions | undefined, overrideOptions?: StartServerOptions): { profile: ServeProfile; options: StartServerOptions } {
  const baseOptions = looksLikeStartServerOptions(input) ? input : {};
  const profile = looksLikeStartServerOptions(input) ? (input.profile ?? {}) : (input ?? {});
  return {
    profile: { ...profile, ...overrideOptions?.profile },
    options: { ...baseOptions, ...overrideOptions },
  };
}

function profileFlag(profile: ServeProfile, key: "intervals" | "views"): boolean {
  return profile[key] !== false;
}

// --- Server ---

export async function startServer(
  port = +(process.env.MAW_PORT || loadConfig().port || 3456),
  profileOrOptions: StartServerProfileOrOptions = {},
  overrideOptions?: StartServerOptions,
) {
  const { options } = resolveStartServerInputs(profileOrOptions, overrideOptions);
  const verbosity = options.verbosity ?? normalizeServeVerbosity(process.env.MAW_SERVE_VERBOSITY);
  const log = createServeLogger(verbosity);
  const config = loadConfig();
  const gateway = selectGateway({ cliGateway: options.gateway, env: process.env, config, log });
  if (gateway.kind !== "rust") return startBunGatewayServer(port, profileOrOptions, overrideOptions);
  return gateway.start(port, options);
}

export async function startBunGatewayServer(
  port = +(process.env.MAW_PORT || loadConfig().port || 3456),
  profileOrOptions: StartServerProfileOrOptions = {},
  overrideOptions?: StartServerOptions,
) {
  const { profile, options } = resolveStartServerInputs(profileOrOptions, overrideOptions);
  const verbosity = options.verbosity ?? normalizeServeVerbosity(process.env.MAW_SERVE_VERBOSITY);
  const log = createServeLogger(verbosity);
  const engine = new MawEngine({ feedBuffer, feedListeners, intervals: profileFlag(profile, "intervals") });
  const serveRoutes = new ServeRouteRegistry();
  const serveWs = new ServeWsRegistry();
  registerServeWs({
    ws: serveWs,
    engine,
  });

  const HTTP_URL = `http://localhost:${port}`;
  const WS_URL = `ws://localhost:${port}/ws`;

  // Connect transport router (non-blocking — server starts even if transports fail)
  // Guard stays in the original startup slot so lean profiles do not reorder
  // side effects relative to dispatch, trigger listeners, and feed plugin setup.
  if (profile.transports === undefined || profile.transports.length > 0) {
    try {
      const router = createScopedTransportRouter(profile.transports);
      router.connectAll().catch(err => log.error("[transport] connect failed:", err));
      engine.setTransportRouter(router);
    } catch (err) {
      log.error("[transport] router init failed:", err);
    }
  }

  // Start dispatch engine — auto-delivers queued messages when agents become idle
  if (profileFlag(profile, "intervals")) startDispatchEngine(sendKeys);

  // Hook workflow triggers into feed events
  setupTriggerListener(feedListeners);
  // NOTE: the worklog engine (capture listener + /api/worklog route) is registered
  // by the `watch` plugin's serve lifecycle hook, not here — so disabling the
  // plugin turns the engine off. See src/vendor/mpr-plugins/watch/serve.ts.
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
    const { resetDiscoverCache } = require("../plugin/registry");
    const { resolve, dirname } = require("path");
    const plugins = new PluginSystem({
      shouldSkipHandler: (eventName: string, pluginName: string | undefined) =>
        hasEnginePluginEventSink(pluginName, eventName),
    });
    serveLifecyclePlugins = plugins;

    const refreshManifestHooks = async () => {
      resetDiscoverCache();
      if (typeof (plugins as { unloadManifestHooks?: () => Promise<unknown> | void }).unloadManifestHooks === "function") {
        await (plugins as { unloadManifestHooks?: () => Promise<unknown> | void }).unloadManifestHooks?.();
      }
      await registerManifestHooks(plugins);
    };

    // Built-in plugins (ship with maw-js)
    const builtinDir = resolve(dirname(new URL(import.meta.url).pathname), "plugins", "builtin");
    await loadPlugins(plugins, builtinDir, "builtin");

    // User plugins (file-drop: XDG data plugin dir; overridable for tests/dev)
    const userPluginsDir = process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
    serveLifecycleReloadPlugins = async () => {
      await reloadUserPlugins(plugins, userPluginsDir);
      await refreshManifestHooks();
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
    await refreshManifestHooks();

    // Hot-reload: watch user and project-local plugin dirs and re-import on
    // .ts/.js/.wasm change. Builtin plugins are not touched. Opt out with
    // MAW_HOT_RELOAD=0.
    watchUserPlugins(userPluginsDir, async (changedFile: string) => {
      log.info(`[plugin] reloading user plugins (${changedFile} changed)`);
      await reloadUserPlugins(plugins, userPluginsDir);
      await refreshManifestHooks();
    });
    for (const dir of projectPluginDirs) {
      watchUserPlugins(dir, async (changedFile: string) => {
        log.info(`[plugin] reloading project plugins (${changedFile} changed)`);
        plugins.unloadScope("project");
        for (const projectDir of projectPluginDirs) {
          await loadPlugins(plugins, projectDir, "project", true);
        }
        plugins._markReloaded?.();
        await refreshManifestHooks();
      });
    }

    // Single feedListener wires everything through the plugin pipeline
    feedListeners.add((event) => plugins.emit(event));

  } catch (err) {
    log.error("[plugins] failed to init:", err);
  }

  const uiStateAccessLogState: UiStateAccessLogState = { count: 0, windowStartedAt: Date.now() };

  const fetchHandler = async (req: Request, server: any) => {
    const startedAt = Date.now();
    const url = new URL(req.url);
    const apiPath = url.pathname.replace(/^\/api/, "");
    const logAccess = (response?: Response) => {
      const status = response?.status ?? 101;
      const finishedAt = Date.now();
      if (url.pathname === UI_STATE_ACCESS_LOG_PATH) {
        if (verbosity >= 3) {
          const batchLine = formatBatchedUiStateAccessLog(uiStateAccessLogState, {
            method: req.method,
            status,
            now: finishedAt,
          });
          if (batchLine) log.access(batchLine);
        }
        return response;
      }
      log.access(`[serve:http] ${req.method} ${url.pathname}${url.search} -> ${status} ${finishedAt - startedAt}ms`);
      return response;
    };

    const addCors = (r: Response) => addCorsHeaders(req, r);

    // CORS preflight for all routes
    const corsPreflight = handleCorsOptions(req);
    if (corsPreflight) return logAccess(corsPreflight);
    const wsUpgrade = serveWs.handleUpgrade(req, server);
    if (wsUpgrade.matched) return logAccess(wsUpgrade.response);
    // Elysia handles legacy /api/* routes (has its own CORS). Engine plugin
    // proxy stays first. For protected routes extracted into serve plugins,
    // preserve Elysia auth hooks by running legacy api.handle(req.clone())
    // before the registry and falling through only when legacy returns 404.
    if (url.pathname.startsWith("/api")) {
      const enginePlugin = findEnginePluginRegistration(url.pathname);
      if (enginePlugin) return logAccess(await proxyEnginePluginRequest(req, enginePlugin));
      if (isProtected(apiPath, req.method)) {
        // Hand the ORIGINAL request to the auth/legacy handler — federation-auth
        // resolves loopback via server.requestIP(request), and Bun only tracks
        // the socket for the original Request object. Passing req.clone() here
        // made requestIP() return undefined, so local loopback callers (the
        // status-reporter hook, maw's own emitFeed, any local CLI) were treated
        // as non-loopback and rejected with 401. The clone goes to the plugin
        // fall-through instead, which doesn't need requestIP.
        const fresh = req.clone();
        const authOrLegacyRoute = await api.handle(req);
        if (authOrLegacyRoute.status !== 404) return logAccess(authOrLegacyRoute);
        const servedByPlugin = await serveRoutes.handle(fresh);
        return logAccess(servedByPlugin ? addCors(servedByPlugin) : authOrLegacyRoute);
      }
      const servedByPlugin = await serveRoutes.handle(req);
      if (servedByPlugin) return logAccess(addCors(servedByPlugin));
      return logAccess(await api.handle(req));
    }
    const servedByPlugin = await serveRoutes.handle(req);
    if (servedByPlugin) return logAccess(addCors(servedByPlugin));

    // Plugin-registered fallbacks handle views + static — clone response with CORS headers
    const res = serveRoutes.handleFallback(req, { server });
    if (res instanceof Promise) return logAccess(addCors(await res));
    return logAccess(addCors(res as Response));
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

  // P1 heartbeat-reaper: Bun-managed ws ping/pong + idle close. Dead clients
  // (ungraceful disconnect, no TCP FIN) close after wsIdleSec → close handler
  // fires → handlePtyClose → detach → grace-timer reaps the maw-pty- tmux session.
  // sendPings: true is Bun's default but pinned for explicitness. Shared across
  // the HTTP + TLS Bun.serve calls below so both ws surfaces get the heartbeat.
  const wsHandlers = {
    open: (ws: any) => {
      log.frame(`[serve:ws] open ${websocketRouteLabel(ws)}`);
      return serveWs.handlers.open(ws);
    },
    message: (ws: any, message: unknown) => {
      log.frame(`[serve:ws] message ${websocketRouteLabel(ws)} ${websocketFrameSize(message)}`);
      return serveWs.handlers.message(ws, message);
    },
    close: (ws: any, code?: number, reason?: string) => {
      const suffix = code === undefined ? "" : ` code=${code}${reason ? ` reason=${reason}` : ""}`;
      log.frame(`[serve:ws] close ${websocketRouteLabel(ws)}${suffix}`);
      return serveWs.handlers.close(ws, code, reason);
    },
  };
  const wsConfig = { ...wsHandlers, idleTimeout: cfgTimeout("wsIdleSec"), sendPings: true };

  log.debug(`[serve:debug] running serve lifecycle hooks`);
  await runServeLifecycleHooks({
    port,
    httpUrl: HTTP_URL,
    wsUrl: WS_URL,
    hostname,
    http: serveRoutes,
    ws: serveWs,
    engine,
    log,
    plugins: serveLifecyclePlugins,
    reloadPlugins: serveLifecycleReloadPlugins,
    profile: {
      views: profileFlag(profile, "views"),
      apiRouters: profile.apiRouters,
    },
  }, undefined, {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  });

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

  const bindNote = reason ? ` (${reason})` : "";
  log.info(`maw ${VERSION} serve → ${HTTP_URL} (${WS_URL}) [${hostname}]${bindNote}`);

  const routeSnapshot = collectServeRouteSnapshot({ http: serveRoutes, ws: serveWs });
  (server as unknown as Record<symbol, ServeRouteSnapshotEntry[]>)[SERVE_ROUTE_SNAPSHOT_SYMBOL] = routeSnapshot;

  // HTTPS server (if TLS configured)
  const tlsCfg = loadConfig().tls;
  if (tlsCfg?.cert && tlsCfg?.key && existsSync(tlsCfg.cert) && existsSync(tlsCfg.key)) {
    const tlsPort = port + 1;
    const tls = { cert: readFileSync(tlsCfg.cert), key: readFileSync(tlsCfg.key) };
    let tlsServer: ReturnType<typeof Bun.serve>;
    try {
      tlsServer = Bun.serve({ port: tlsPort, tls, fetch: fetchHandler, websocket: wsConfig });
    } catch (err) {
      try { server.stop(true); } catch { /* best effort: startup is already failing */ }
      if (isAddressInUseError(err)) {
        for (const line of servePortInUseInstructions(tlsPort, hostname)) log.error(line);
        throw new UserError(`maw serve TLS port ${tlsPort} is already in use`);
      }
      throw err;
    }
    bindTlsServerStop(server, tlsServer);
    log.info(`maw serve → https://localhost:${tlsPort} (wss://localhost:${tlsPort}/ws) [TLS]`);
  }

  return server;
}

// Auto-start unless imported by CLI (CLI sets MAW_CLI=1)
if (!process.env.MAW_CLI) {
  startServer();
}
