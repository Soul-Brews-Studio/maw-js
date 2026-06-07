/**
 * Dispatch plugin event hooks directly from plugin manifest declarations.
 *
 * Runtime bridge for event names declared in `hooks.on` when plugins expose
 * ABI-style handlers (e.g. `onTransportAfterSend` for
 * `transport:after_send`).
 */

import { discoverPackages } from "./registry";
import type { LoadedPlugin } from "./types";
import type { TransportResult, TransportTarget } from "../core/transport/transport";
import type { PluginEventMap } from "../../packages/sdk/events";

export type PluginEventName = keyof PluginEventMap | string;

export type PluginEventPayload<T extends PluginEventName> = T extends keyof PluginEventMap
  ? PluginEventMap[T]
  : {
      [key: string]: unknown;
    };

function capitalize(value: string): string {
  if (!value) return "";
  return value[0].toUpperCase() + value.slice(1);
}

function pascalCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => capitalize(part.toLowerCase()))
    .join("");
}

function eventToHandlerName(eventName: string): string {
  const [scopeRaw, actionRaw] = eventName.split(":", 2);
  const scope = capitalize(scopeRaw.toLowerCase());
  const action = actionRaw ? pascalCase(actionRaw) : "";
  return `on${scope}${action}`;
}

function shouldRunPluginEventHook(plugin: LoadedPlugin, eventName: string): boolean {
  if (plugin.disabled) return false;
  if (plugin.kind !== "ts") return false;
  if (!plugin.entryPath) return false;
  const hooks = plugin.manifest.hooks;
  if (!hooks?.on || !Array.isArray(hooks.on)) return false;
  return hooks.on.includes(eventName);
}

function invokePluginEventHook(
  plugin: LoadedPlugin,
  eventName: string,
  payload: unknown,
): Promise<void> {
  const handlerName = eventToHandlerName(eventName);
  return import(plugin.entryPath!).then((mod) => {
    const handler = mod[handlerName];
    if (typeof handler !== "function") return;
    return handler(payload);
  }).then(() => {}).catch((err) => {
    throw new Error(`failed loading/dispatching plugin ${plugin.manifest.name}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export async function runPluginEventHooks<T extends PluginEventName>(
  event: T,
  payload: PluginEventPayload<T>,
): Promise<void> {
  for (const plugin of discoverPackages()) {
    if (!shouldRunPluginEventHook(plugin, event)) continue;
    try {
      await invokePluginEventHook(plugin, event, payload);
    } catch (error) {
      console.error(
        `[plugin:event-hooks] ${event} failed for ${plugin.manifest.name}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export type { TransportResult, TransportTarget };
