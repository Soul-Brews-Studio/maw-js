import { discoverPackages } from "./registry";
import type { LoadedPlugin } from "./types";

type DiscoverPlugins = () => LoadedPlugin[];
type AnyRecord = Record<string, unknown>;

export interface PluginEventHooksSummary {
  eventName: string;
  matched: number;
  invoked: number;
  skipped: number;
  failed: number;
}

const EVENT_HANDLER_EXPORTS = ["onEvent", "on", "handle"];

function pascalCase(token: string): string {
  return token
    .split(/[-_.:]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function deriveEventHandlerName(eventName: string): string {
  const [scope, action] = eventName.split(":", 2);
  if (!action) return `on${pascalCase(scope)}`;
  return `on${pascalCase(scope)}${pascalCase(action)}`;
}

function sortByLifecycleOrder(plugins: LoadedPlugin[]): LoadedPlugin[] {
  return [...plugins].sort(
    (a, b) =>
      (a.manifest.weight ?? 50) - (b.manifest.weight ?? 50)
      || a.manifest.name.localeCompare(b.manifest.name),
  );
}

function getEventHandler(mod: AnyRecord, eventName: string): ((payload: AnyRecord) => unknown) | null {
  const eventHandler = eventName ? mod[deriveEventHandlerName(eventName)] : undefined;
  if (typeof eventHandler === "function") {
    return eventHandler as AnyRecord[keyof AnyRecord] as ((payload: AnyRecord) => unknown);
  }
  for (const name of EVENT_HANDLER_EXPORTS) {
    const value = mod[name];
    if (typeof value === "function") return value as AnyRecord[keyof AnyRecord] as ((payload: AnyRecord) => unknown);
  }
  return null;
}

function shouldHandle(hooks: { on?: string[] } | undefined, eventName: string): boolean {
  const events = hooks?.on;
  if (!Array.isArray(events)) return false;
  return events.includes(eventName) || events.includes("*");
}

export async function runPluginEventHooks(
  eventName: string,
  payload: AnyRecord,
  discover: DiscoverPlugins = discoverPackages,
): Promise<PluginEventHooksSummary> {
  const summary: PluginEventHooksSummary = {
    eventName,
    matched: 0,
    invoked: 0,
    skipped: 0,
    failed: 0,
  };

  for (const plugin of sortByLifecycleOrder(discover())) {
    if (plugin.disabled) {
      summary.skipped += 1;
      continue;
    }
    if (plugin.kind !== "ts" || !plugin.entryPath) {
      summary.skipped += 1;
      continue;
    }
    if (!shouldHandle(plugin.manifest.hooks, eventName)) {
      continue;
    }

    summary.matched += 1;
    try {
      const mod = await import(plugin.entryPath);
      const handler = getEventHandler(mod as AnyRecord, eventName);
      if (!handler) {
        summary.failed += 1;
        continue;
      }
      await handler({
        ...(payload as object),
        plugin: {
          name: plugin.manifest.name,
          dir: plugin.dir,
        },
      } as AnyRecord);
      summary.invoked += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
