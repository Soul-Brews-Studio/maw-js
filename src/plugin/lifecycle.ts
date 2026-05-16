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
import type { LoadedPlugin, PluginLifecycleHook } from "./types";

export type LifecyclePhase = "wake" | "sleep" | "serve";

export interface PluginLifecycleContext {
  phase: LifecyclePhase;
  plugin: { name: string; dir: string };
  oracle?: string;
  session?: string;
  window?: string;
  target?: string;
  repoPath?: string;
  repoName?: string;
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

export interface LifecycleRunSummary {
  phase: LifecyclePhase;
  ran: number;
  skipped: number;
  failed: number;
}

export type LifecycleDiscover = () => LoadedPlugin[];

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
    ...baseContext,
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
): Promise<LifecycleRunSummary> {
  const summary: LifecycleRunSummary = { phase, ran: 0, skipped: 0, failed: 0 };

  for (const plugin of sortByLifecycleOrder(discover())) {
    if (plugin.disabled) { summary.skipped++; continue; }
    const hook = plugin.manifest.hooks?.[phase];
    if (!hook) continue;
    if (plugin.kind !== "ts" && !hook.script) { summary.skipped++; continue; }

    try {
      await runOneLifecycleHook(phase, plugin, hook, baseContext);
      summary.ran++;
    } catch (error) {
      summary.failed++;
      const msg = messageOf(error);
      if (hook.policy === "fail-fast") {
        throw new Error(`plugin lifecycle ${phase} failed for ${plugin.manifest.name}: ${msg}`);
      }
      console.warn(`\x1b[33m⚠\x1b[0m plugin lifecycle ${phase}:${plugin.manifest.name} failed: ${msg}`);
    }
  }

  if (summary.ran > 0) {
    console.log(`\x1b[36m↻\x1b[0m plugin lifecycle ${phase}: ${summary.ran} hook${summary.ran === 1 ? "" : "s"}`);
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
