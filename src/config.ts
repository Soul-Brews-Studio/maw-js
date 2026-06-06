// Barrel — re-exports from split config modules.
export type { TriggerEvent, TriggerConfig, PeerConfig, MawIntervals, MawTimeouts, MawLimits, MawConfig } from "./config/types";
export { D } from "./config/types";
export { DEFAULT_ENGINES, resolveEngine } from "./config/engine-registry";
export type { EngineDef } from "./config/engine-def";
export type { EngineRegistry } from "./config/engine-registry";
export { validateConfigShape } from "./config/validate";
export { loadConfig, loadConfigWithProvenance, resetConfig, saveConfig, configForDisplay, cfgInterval, cfgTimeout, cfgLimit, cfg } from "./config/load";
export { buildCommand, buildCommandInDir, getEnvVars } from "./config/command";
