// Barrel — re-exports everything so all existing import paths remain unchanged.
// `getGhqRoot` lives HERE (not re-exported from `./config/ghq-root`) because
// bun's CJS/ESM interop loses the named binding through re-export under
// `require()` from some test files (#712).
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

// Re-export everything from split modules.
export type { TriggerEvent, TriggerConfig, PeerConfig, MawIntervals, MawTimeouts, MawLimits, MawConfig } from "./config/types";
export { D } from "./config/types";
export { validateConfigShape } from "./config/validate";
export { loadConfig, resetConfig, saveConfig, configForDisplay, cfgInterval, cfgTimeout, cfgLimit, cfg } from "./config/load";
export { buildCommand, buildCommandInDir, getEnvVars } from "./config/command";

// loadConfig is needed below for the legacy-override branch of getGhqRoot.
// Import it directly rather than relying on the re-export.
import { loadConfig as _loadConfig } from "./config/load";

// ─── ghq root resolver (inlined — see banner comment) ────────────────────────
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
    const cfg = _loadConfig() as { ghqRoot?: string };
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
