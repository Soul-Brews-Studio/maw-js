/**
 * Plugin lifecycle runner (#1576).
 *
 * Manifest parsing already preserves hooks.wake/sleep/serve. This module is the
 * first execution surface: deterministic, enabled-plugin-only, TS/JS module
 * hooks with explicit failure policy.
 */

import { existsSync, realpathSync } from "fs";
import { resolve, sep } from "path";
import { pathToFileURL } from "url";
import { discoverPackages } from "./registry";
import type { MawEngine } from "../engine";
import type { ServeWsRouteRegistrar } from "../core/serve-ws-registry";
import type { MawConfig } from "../config/types";
import type { TransportRouter } from "../core/transport/transport";
import type { ServeProfile } from "../core/server";
import type { LoadedPlugin, PluginLifecycleHook, ServeRouteRegistrar } from "./types";

export type LifecyclePhase = "wake" | "sleep" | "serve" | "transport";

export interface PluginLifecycleContext {
  phase: LifecyclePhase;
  plugin: { name: string; dir: string };
  oracle?: string;
  session?: string;
  window?: string;
  target?: string;
  repoPath?: string;
  repoName?: string;
  port?: number;
  httpUrl?: string;
  wsUrl?: string;
  hostname?: string;
  http?: ServeRouteRegistrar;
  ws?: ServeWsRouteRegistrar;
  engine?: MawEngine;
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensures?: string[];
}

export interface WakeLifecycleContextInput {
  oracle: string;
  session: string;
  repoPath: string;
  repoName: string;
}

export interface SleepLifecycleContextInput {
  oracle: string;
  session: string;
  window: string;
  target: string;
}

export interface ServeLifecycleContextInput {
  port: number;
  httpUrl: string;
  wsUrl: string;
  hostname: string;
  http?: ServeRouteRegistrar;
  ws?: ServeWsRouteRegistrar;
  engine?: MawEngine;
  /** Serve logger scoped by CLI verbosity for core lifecycle plugins. */
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** In-memory feed plugin system, exposed for serve diagnostics/debug plugins. */
  plugins?: unknown;
  /** Reload user plugins and return the current plugin stats/debug payload. */
  reloadPlugins?: () => unknown | Promise<unknown>;
  /** Optional lean serve composition profile for filtering serve hook mounts. */
  profile?: Pick<ServeProfile, "views" | "apiRouters">;
}

export interface TransportLifecycleContextInput {
  router: TransportRouter;
  config: MawConfig;
  /** Transport lifecycle logger scoped by CLI verbosity for transport plugins. */
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

export interface LifecycleRunSummary {
  phase: LifecyclePhase;
  ran: number;
  skipped: number;
  failed: number;
}

export type LifecycleDiscover = () => LoadedPlugin[];
export type LifecycleLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

function sortByLifecycleOrder(plugins: LoadedPlugin[]): LoadedPlugin[] {
  return [...plugins].sort((a, b) =>
    (a.manifest.weight ?? 50) - (b.manifest.weight ?? 50)
    || a.manifest.name.localeCompare(b.manifest.name),
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}


type PluginScopedServeRoutes = ServeRouteRegistrar & {
  forPlugin?: (plugin: { name: string; dir?: string }) => ServeRouteRegistrar;
};

function scopedServeContext(
  baseContext: Omit<PluginLifecycleContext, "phase" | "plugin" | "ensures">,
  plugin: LoadedPlugin,
): Omit<PluginLifecycleContext, "phase" | "plugin" | "ensures"> {
  const http = baseContext.http as PluginScopedServeRoutes | undefined;
  if (!http?.forPlugin) return baseContext;
  return {
    ...baseContext,
    http: http.forPlugin({ name: plugin.manifest.name, dir: plugin.dir }),
  };
}

function resolveHookModulePath(plugin: LoadedPlugin, hook: PluginLifecycleHook): string {
  const pluginRoot = realpathSync(plugin.dir);
  const rawPath = hook.script
    ? resolve(plugin.dir, hook.script)
    : plugin.entryPath;

  if (!rawPath) {
    throw new Error("lifecycle hook needs hooks.<phase>.script or plugin entry");
  }

  if (!existsSync(rawPath)) {
    throw new Error(`lifecycle hook script missing: ${hook.script ?? rawPath}`);
  }

  const realPath = realpathSync(rawPath);
  if (realPath !== pluginRoot && !realPath.startsWith(pluginRoot + sep)) {
    throw new Error(`lifecycle hook script escapes plugin dir: ${hook.script ?? rawPath}`);
  }
  return realPath;
}

function serveApiRouterName(pluginName: string): string | null {
  if (pluginName === "serve-views" || pluginName === "serve-ws") return null;
  if (pluginName.startsWith("serve-")) return pluginName.slice("serve-".length);
  return pluginName;
}

function shouldRunLifecycleHook(
  phase: LifecyclePhase,
  plugin: LoadedPlugin,
  baseContext: Omit<PluginLifecycleContext, "phase" | "plugin" | "ensures">,
): boolean {
  if (phase !== "serve") return true;
  const profile = (baseContext as { profile?: Pick<ServeProfile, "views" | "apiRouters"> }).profile;
  if (!profile) return true;
  const pluginName = plugin.manifest.name;
  if (profile.views === false && pluginName === "serve-views") return false;
  if (profile.apiRouters === undefined) return true;
  const routerName = serveApiRouterName(pluginName);
  return routerName === null || profile.apiRouters.includes(routerName);
}

async function runOneLifecycleHook(
  phase: LifecyclePhase,
  plugin: LoadedPlugin,
  hook: PluginLifecycleHook,
  baseContext: Omit<PluginLifecycleContext, "phase" | "plugin" | "ensures">,
): Promise<void> {
  const modulePath = resolveHookModulePath(plugin, hook);
  const mod = await import(pathToFileURL(modulePath).href);
  const handlerName = hook.handler ?? phase;
  const handler = mod[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`lifecycle handler '${handlerName}' not exported by ${modulePath}`);
  }

  const result = await handler({
    ...scopedServeContext(baseContext, plugin),
    phase,
    plugin: { name: plugin.manifest.name, dir: plugin.dir },
    ensures: hook.ensures ?? [],
  } satisfies PluginLifecycleContext);

  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    throw new Error(typeof result.error === "string" ? result.error : "lifecycle hook returned ok:false");
  }
}

export async function runLifecycleHooks(
  phase: LifecyclePhase,
  baseContext: Omit<PluginLifecycleContext, "phase" | "plugin" | "ensures"> = {},
  discover: LifecycleDiscover = discoverPackages,
  logger: LifecycleLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  },
): Promise<LifecycleRunSummary> {
  const summary: LifecycleRunSummary = { phase, ran: 0, skipped: 0, failed: 0 };
  const ranPluginNames: string[] = [];

  for (const plugin of sortByLifecycleOrder(discover())) {
    if (plugin.disabled) { summary.skipped++; continue; }
    const hook = plugin.manifest.hooks?.[phase];
    if (!hook) continue;
    if (!shouldRunLifecycleHook(phase, plugin, baseContext)) { summary.skipped++; continue; }
    if (plugin.kind !== "ts" && !hook.script) { summary.skipped++; continue; }

    try {
      await runOneLifecycleHook(phase, plugin, hook, baseContext);
      summary.ran++;
      ranPluginNames.push(plugin.manifest.name);
    } catch (error) {
      summary.failed++;
      const msg = messageOf(error);
      if (hook.policy === "fail-fast") {
        throw new Error(`plugin lifecycle ${phase} failed for ${plugin.manifest.name}: ${msg}`);
      }
      logger.warn(`\x1b[33m⚠\x1b[0m plugin lifecycle ${phase}:${plugin.manifest.name} failed: ${msg}`);
    }
  }

  if (summary.ran > 0) {
    const names = ranPluginNames.length > 0 ? ` (${ranPluginNames.join(", ")})` : "";
    logger.info(`\x1b[36m↻\x1b[0m plugin lifecycle ${phase}: ${summary.ran} hook${summary.ran === 1 ? "" : "s"}${names}`);
  }
  return summary;
}

export function runWakeLifecycleHooks(
  context: WakeLifecycleContextInput,
  discover?: LifecycleDiscover,
): Promise<LifecycleRunSummary> {
  return runLifecycleHooks("wake", context, discover);
}

export function runSleepLifecycleHooks(
  context: SleepLifecycleContextInput,
  discover?: LifecycleDiscover,
): Promise<LifecycleRunSummary> {
  return runLifecycleHooks("sleep", context, discover);
}

export function runServeLifecycleHooks(
  context: ServeLifecycleContextInput,
  discover?: LifecycleDiscover,
  logger?: LifecycleLogger,
): Promise<LifecycleRunSummary> {
  return runLifecycleHooks("serve", context, discover, logger);
}

export function runTransportLifecycleHooks(
  context: TransportLifecycleContextInput,
  discover?: LifecycleDiscover,
  logger?: LifecycleLogger,
): Promise<LifecycleRunSummary> {
  return runLifecycleHooks("transport", context, discover, logger);
}
