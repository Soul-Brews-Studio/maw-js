/**
 * Auto-register hooks from plugin manifests → PluginSystem.
 * Reads manifest.hooks, imports entry, registers exported hook functions.
 * Weight-sorted: lower weight fires first (Drupal convention).
 */

import type { PluginSystem } from "./system";

const PHASE_EXPORTS = {
  gate: ["onGate", "gate"],
  filter: ["onFilter", "filter"],
  on: ["onEvent", "on", "handle"],
  late: ["onLate", "late", "cleanup"],
} as const;

export async function registerManifestHooks(system: PluginSystem): Promise<number> {
  const { discoverPackages } = await import("../plugin/registry");
  const plugins = discoverPackages(); // already sorted by weight

  let registered = 0;
  for (const plugin of plugins) {
    if (!plugin.manifest.hooks || plugin.kind !== "ts" || !plugin.entryPath) continue;

    let mod: any;
    try { mod = await import(plugin.entryPath); } catch { continue; }

    const hooks = plugin.manifest.hooks;

    for (const [phase, exportNames] of Object.entries(PHASE_EXPORTS)) {
      const events = hooks[phase as keyof typeof hooks];
      if (!events) continue;

      const fn = exportNames.reduce((f: any, name: string) => f ?? mod[name], null);
      if (typeof fn !== "function") continue;

      for (const event of events) {
        (system.hooks as any)[phase](event, fn);
        registered++;
      }
    }

    if (registered > 0) {
      system.register(plugin.manifest.name, "ts", "user");
    }
  }

  return registered;
}
