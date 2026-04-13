/**
 * Plugin system — re-exports from split modules.
 * No file over 150 LOC. Each module has one responsibility.
 */

export type { MawPlugin, MawHooks, PluginScope, PluginInfo } from "./types";
export { PluginSystem } from "./system";
export { loadPlugins, reloadUserPlugins } from "./loader";
export { registerManifestHooks } from "./hooks-registry";
export { watchUserPlugins } from "./watcher";
