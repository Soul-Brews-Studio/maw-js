/**
 * plugins seam: doEnable + doDisable implementations.
 */

import { discoverPackages, resetDiscoverCache } from "../../plugin/registry";
import { pluginCliNames } from "../../cli/dispatch-match";
import { pluginDependencyNames } from "../../plugin/dependencies";

function resolvePluginToggleName(input: string, plugins = discoverPackages()): string {
  const exact = plugins.find(p => p.manifest.name === input);
  if (exact) return exact.manifest.name;

  const lower = input.toLowerCase();
  const byCli = plugins.find(p => {
    const cli = pluginCliNames(p);
    if (!cli) return false;
    return cli.command.toLowerCase() === lower
      || cli.aliases.some(alias => alias.toLowerCase() === lower);
  });
  return byCli?.manifest.name ?? input;
}

export function doEnable(nameOrNames: string | string[]): void {
  const { loadConfig, saveConfig } = require("../../config");
  const config = loadConfig();
  const disabled = config.disabledPlugins ?? [];
  const disabledSet = new Set(disabled as string[]);
  const plugins = discoverPackages();
  const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
  const requested = names.map(name => ({ input: name, pluginName: resolvePluginToggleName(name, plugins) }));
  const byName = new Map(plugins.map(p => [p.manifest.name, p]));
  const toEnable: string[] = [];

  function addIfDisabled(pluginName: string): void {
    if (disabledSet.has(pluginName) && !toEnable.includes(pluginName)) toEnable.push(pluginName);
  }

  function addDisabledDependencies(pluginName: string, seen = new Set<string>()): void {
    if (seen.has(pluginName)) return;
    seen.add(pluginName);
    const plugin = byName.get(pluginName);
    if (!plugin) return;
    for (const dep of pluginDependencyNames(plugin)) {
      addDisabledDependencies(dep, seen);
      addIfDisabled(dep);
    }
  }

  for (const { pluginName } of requested) {
    addDisabledDependencies(pluginName);
    addIfDisabled(pluginName);
  }

  if (toEnable.length === 0) {
    const label = requested.length === 1 && requested[0].pluginName !== requested[0].input
      ? `${requested[0].input} (${requested[0].pluginName})`
      : names.join(", ");
    console.log(`${label} is already enabled`);
    return;
  }
  const enableSet = new Set(toEnable);
  saveConfig({ disabledPlugins: disabled.filter((n: string) => !enableSet.has(n)) });
  resetDiscoverCache();  // config change → next discover call reflects it
  console.log(`\x1b[32m✓\x1b[0m enabled ${toEnable.join(", ")}`);
}

export function doDisable(name: string): void {
  const { loadConfig, saveConfig } = require("../../config");
  const config = loadConfig();
  const disabled = config.disabledPlugins ?? [];
  const pluginName = resolvePluginToggleName(name);
  if (disabled.includes(pluginName)) {
    const label = pluginName === name ? name : `${name} (${pluginName})`;
    console.log(`${label} is already disabled`);
    return;
  }
  // Verify plugin exists
  const plugins = discoverPackages();
  if (!plugins.find(p => p.manifest.name === pluginName)) {
    console.error(`plugin not found: ${name}`);
    process.exit(1);
  }
  saveConfig({ disabledPlugins: [...disabled, pluginName] });
  resetDiscoverCache();  // config change → next discover call reflects it
  console.log(`\x1b[33m✗\x1b[0m disabled ${pluginName}`);
}
