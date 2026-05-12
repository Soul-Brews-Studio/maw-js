// Barrel — re-exports from split config modules.
export type { TriggerEvent, TriggerConfig, PeerConfig, MawIntervals, MawTimeouts, MawLimits, MawConfig } from "./config/types";
export { D } from "./config/types";
export { validateConfigShape } from "./config/validate";
export { loadConfig, resetConfig, saveConfig, configForDisplay, cfgInterval, cfgTimeout, cfgLimit, cfg } from "./config/load";
export { buildCommand, buildCommandInDir, buildRespawnCommand, writeSessionScript, getEnvVars } from "./config/command";
