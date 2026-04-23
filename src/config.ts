// Barrel — re-exports everything so all existing import paths remain unchanged.
// Use explicit import + export (not `export {} from`) to avoid bun CJS/ESM
// re-export interop issues (#712: soul-sync tests blew up with
// "Export named 'getGhqRoot' not found" when tests `require()` this module).
import type {
  TriggerEvent as _TriggerEvent,
  TriggerConfig as _TriggerConfig,
  PeerConfig as _PeerConfig,
  MawIntervals as _MawIntervals,
  MawTimeouts as _MawTimeouts,
  MawLimits as _MawLimits,
  MawConfig as _MawConfig,
} from "./config/types";
import { D } from "./config/types";
import { validateConfigShape } from "./config/validate";
import {
  loadConfig,
  resetConfig,
  saveConfig,
  configForDisplay,
  cfgInterval,
  cfgTimeout,
  cfgLimit,
  cfg,
} from "./config/load";
import { buildCommand, buildCommandInDir, getEnvVars } from "./config/command";
import { getGhqRoot, resetGhqRootCache } from "./config/ghq-root";

export type TriggerEvent = _TriggerEvent;
export type TriggerConfig = _TriggerConfig;
export type PeerConfig = _PeerConfig;
export type MawIntervals = _MawIntervals;
export type MawTimeouts = _MawTimeouts;
export type MawLimits = _MawLimits;
export type MawConfig = _MawConfig;

export {
  D,
  validateConfigShape,
  loadConfig,
  resetConfig,
  saveConfig,
  configForDisplay,
  cfgInterval,
  cfgTimeout,
  cfgLimit,
  cfg,
  buildCommand,
  buildCommandInDir,
  getEnvVars,
  getGhqRoot,
  resetGhqRootCache,
};
