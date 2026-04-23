import { readFileSync, writeFileSync } from "fs";
import { CONFIG_FILE } from "../core/paths";
import { refreshContext } from "../lib/context";
import { verbose, info } from "../cli/verbosity";
import type { MawConfig } from "./types";
import { D } from "./types";
import { validateConfig } from "./validate-ext";

// #680 — ghqRoot is no longer resolved at config-load time. Callers that need
// a filesystem path go through `getGhqRoot()` (src/config/ghq-root.ts), which
// shells out to `ghq root` on demand. `config.ghqRoot` survives as a legacy
// override; loadConfig() surfaces a one-shot deprecation warning below.
const DEFAULTS: MawConfig = {
  host: "local",
  port: 3456,
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
};

let warnedGhqRoot = false;

let cached: MawConfig | null = null;

export function loadConfig(): MawConfig {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    const validated = validateConfig(raw);
    cached = { ...DEFAULTS, ...validated };
  } catch {
    cached = { ...DEFAULTS };
  }
  // #680 — warn once if the (deprecated) ghqRoot override is set in config.
  if (!warnedGhqRoot && typeof cached.ghqRoot === "string" && cached.ghqRoot.length > 0) {
    warnedGhqRoot = true;
    process.stderr.write(
      `[maw] config.ghqRoot is deprecated — ghq root is resolved on demand via \`ghq root\`. ` +
      `Remove "ghqRoot" from your maw.config.json (still honored as a legacy override).\n`,
    );
  }
  // One-shot startup summary — fires unless --quiet/--silent (verbose-by-default).
  verbose(() => {
    const nT = cached!.triggers?.length ?? 0;
    const nP = cached!.pluginSources?.length ?? 0;
    const nPeers = (cached!.peers?.length ?? 0) + (cached!.namedPeers?.length ?? 0);
    info(`loaded config: ${nT} trigger${nT === 1 ? "" : "s"}, ${nP} declared plugin${nP === 1 ? "" : "s"}, ${nPeers} peer${nPeers === 1 ? "" : "s"}`);
  });
  return cached;
}

/** Reset cached config (for hot-reload or testing) */
export function resetConfig() {
  cached = null;
  warnedGhqRoot = false;
}

/** Write config to maw.config.json and reset cache */
export function saveConfig(update: Partial<MawConfig>) {
  const current = loadConfig();
  const merged = { ...current, ...update };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  resetConfig(); // clear cache so next loadConfig() reads fresh
  refreshContext(); // clear DI cache so middleware picks up new config
  return loadConfig();
}

/** Return config with env values masked for display */
export function configForDisplay(): MawConfig & { envMasked: Record<string, string> } {
  const config = loadConfig();
  const envMasked: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env)) {
    if (v.length <= 4) {
      envMasked[k] = "\u2022".repeat(v.length);
    } else {
      envMasked[k] = v.slice(0, 3) + "\u2022".repeat(Math.min(v.length - 3, 20));
    }
  }
  const result: any = { ...config, env: {}, envMasked };
  // Mask federation token (show first 4 chars only)
  if (result.federationToken) {
    result.federationToken = result.federationToken.slice(0, 4) + "\u2022".repeat(12);
  }
  return result;
}

/** Get a config interval with typed default fallback */
export function cfgInterval(key: keyof typeof D.intervals): number {
  return loadConfig().intervals?.[key] ?? D.intervals[key];
}

/** Get a config timeout with typed default fallback */
export function cfgTimeout(key: keyof typeof D.timeouts): number {
  return loadConfig().timeouts?.[key] ?? D.timeouts[key];
}

/** Get a config limit with typed default fallback */
export function cfgLimit(key: keyof typeof D.limits): number {
  return loadConfig().limits?.[key] ?? D.limits[key];
}

/** Get a top-level config value with default fallback */
export function cfg<K extends keyof MawConfig>(key: K): MawConfig[K] {
  return loadConfig()[key] ?? (DEFAULTS as MawConfig)[key];
}
