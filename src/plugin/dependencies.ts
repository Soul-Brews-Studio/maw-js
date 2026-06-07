import type { LoadedPlugin } from "./types";

export type PluginDependencyStatus = {
  disabled: string[];
  missing: string[];
};

export function pluginDependencyNames(plugin: LoadedPlugin): string[] {
  return plugin.manifest.dependencies?.plugins ?? [];
}

export function dependencyStatus(plugin: LoadedPlugin, plugins: LoadedPlugin[]): PluginDependencyStatus {
  const byName = new Map(plugins.map(p => [p.manifest.name, p]));
  const disabled: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  function visit(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    const dep = byName.get(name);
    if (!dep) {
      missing.push(name);
      return;
    }
    for (const child of pluginDependencyNames(dep)) visit(child);
    if (dep.disabled) disabled.push(name);
  }

  for (const name of pluginDependencyNames(plugin)) visit(name);
  return { disabled, missing };
}

export function enablePlanFor(plugin: LoadedPlugin, plugins: LoadedPlugin[], includeSelf: boolean): string[] {
  const { disabled } = dependencyStatus(plugin, plugins);
  const plan = [...disabled];
  if (includeSelf && plugin.disabled) plan.push(plugin.manifest.name);
  return [...new Set(plan)];
}
