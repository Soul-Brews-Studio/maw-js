// Barrel — re-exports everything so all existing import paths remain unchanged.
export type { TriggerEvent, TriggerConfig, PeerConfig, MawIntervals, MawTimeouts, MawLimits, MawConfig } from "./config/types";
export { D } from "./config/types";
export { validateConfigShape } from "./config/validate";
export { loadConfig, resetConfig, saveConfig, configForDisplay, cfgInterval, cfgTimeout, cfgLimit, cfg } from "./config/load";
export { buildCommand, buildCommandInDir, getEnvVars } from "./config/command";
export { getGhqRoot, resetGhqRootCache } from "./config/ghq-root";
