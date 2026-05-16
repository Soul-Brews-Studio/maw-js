/**
 * plugins seam: doEnable + doDisable implementations.
 */

import { discoverPackages, resetDiscoverCache } from "../../plugin/registry";
import { pluginCliNames } from "../../cli/dispatch-match";

function resolvePluginToggleName(input: string): string {
  const plugins = discoverPackages();
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

export function doEnable(name: string): void {
  const { loadConfig, saveConfig } = require("../../config");
  const config = loadConfig();
  const disabled = config.disabledPlugins ?? [];
  const pluginName = resolvePluginToggleName(name);
  if (!disabled.includes(pluginName)) {
    const label = pluginName === name ? name : `${name} (${pluginName})`;
    console.log(`${label} is already enabled`);
    return;
  }
  saveConfig({ disabledPlugins: disabled.filter((n: string) => n !== pluginName) });
  resetDiscoverCache();  // config change → next discover call reflects it
  console.log(`\x1b[32m✓\x1b[0m enabled ${pluginName}`);
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
