// Barrel — re-exports everything so all existing import paths remain unchanged.
// `getGhqRoot` lives HERE (not re-exported from `./config/ghq-root`) because
// bun's CJS/ESM interop loses the named binding through re-export under
// `require()` from some test files (#712). Defining it here keeps the name
// resolvable via both `import` and `require()` paths.
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

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
  loadConfig as _loadConfig,
  resetConfig,
  saveConfig,
  configForDisplay,
  cfgInterval,
  cfgTimeout,
  cfgLimit,
  cfg,
} from "./config/load";
import { buildCommand, buildCommandInDir, getEnvVars } from "./config/command";

export type TriggerEvent = _TriggerEvent;
export type TriggerConfig = _TriggerConfig;
export type PeerConfig = _PeerConfig;
export type MawIntervals = _MawIntervals;
export type MawTimeouts = _MawTimeouts;
export type MawLimits = _MawLimits;
export type MawConfig = _MawConfig;

const loadConfig = _loadConfig;

// ─── ghq root resolver (inlined here to survive bun CJS require interop) ─────
let _ghqCached: string | null = null;
let _warnedLegacy = false;

function normalizeBare(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/github\.com$/, "");
}

export function resetGhqRootCache(): void {
  _ghqCached = null;
  _warnedLegacy = false;
}

export function getGhqRoot(): string {
  if (_ghqCached) return _ghqCached;

  // (1) legacy override from config
  try {
    const cfg = loadConfig() as { ghqRoot?: string };
    if (typeof cfg.ghqRoot === "string" && cfg.ghqRoot.length > 0) {
      const bare = normalizeBare(cfg.ghqRoot);
      if (!_warnedLegacy) {
        _warnedLegacy = true;
        process.stderr.write(
          `[maw] config.ghqRoot is deprecated — ghq root is now resolved on demand. ` +
          `Remove "ghqRoot" from your maw.config.json (using "${bare}" for this run).\n`,
        );
      }
      _ghqCached = bare;
      return _ghqCached;
    }
  } catch { /* loadConfig may fail during early bootstrap */ }

  // (2) env var
  const envRoot = process.env.GHQ_ROOT;
  if (envRoot && envRoot.length > 0) {
    _ghqCached = normalizeBare(envRoot);
    return _ghqCached;
  }

  // (3) shell out to ghq
  try {
    const out = execSync("ghq root", { encoding: "utf-8" }).trim();
    if (out.length > 0) {
      _ghqCached = normalizeBare(out);
      return _ghqCached;
    }
  } catch { /* ghq missing */ }

  // (4) fallback
  _ghqCached = join(homedir(), "Code");
  return _ghqCached;
}

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
};
