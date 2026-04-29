import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_FILE } from "../core/paths";
import { refreshContext } from "../lib/context";
import { verbose, info } from "../cli/verbosity";
import type { MawConfig } from "./types";
import { D } from "./types";
import { validateConfig } from "./validate-ext";
import { loadFleetAgents } from "./fleet-merge";

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
let warnedHostMigrated = false;
let warnedHostNodeConflated = false;

let cached: MawConfig | null = null;

/** Bind-address values that should never appear as an outbound target (#713). */
const BIND_ADDRESSES = new Set(["0.0.0.0", "::", "", "127.0.0.1", "localhost"]);

export function loadConfig(): MawConfig {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    const validated = validateConfig(raw);
    cached = { ...DEFAULTS, ...validated };
  } catch {
    cached = { ...DEFAULTS };
  }
  // #713 — migrate bind-address values out of `host` into `bind`.
  // If `host` is a bind address (0.0.0.0, ::, 127.0.0.1, localhost, ""),
  // move it to `bind` (if not already set) and reset `host` to "local".
  if (typeof cached.host === "string" && BIND_ADDRESSES.has(cached.host)) {
    if (!cached.bind) {
      cached.bind = cached.host;
    }
    if (!warnedHostMigrated) {
      warnedHostMigrated = true;
      process.stderr.write(
        `[maw] config.host "${cached.host}" is a bind address, not a connection target. ` +
        `Migrated to config.bind; host reset to "local". ` +
        `(#713 — set "bind" in maw.config.json to silence this warning.)\n`,
      );
    }
    cached.host = "local";
  }
  // #906 — heal the host=node conflation bug shipped by `maw init` pre-fix.
  // Pre-#906 buildConfig wrote `host: input.node`, conflating the SSH
  // connection target with the node identity. Anyone who ran `maw init`
  // ended up with `host: "<their-machine-name>"`, which made `hostExec`
  // attempt `ssh <node-name> <cmd>` on every fleet-pinned clone (the
  // `lock-trust-node` cryptic error in the wild). The fix in
  // commands/plugins/init/write-config.ts now writes `host: "local"` for
  // fresh installs; this migration heals existing broken configs at load
  // time without operator action: when host === node and host is NOT
  // already a known-good target ("local"/"localhost"), reset to "local".
  // We deliberately do NOT touch configs where the operator hand-set
  // `host` to something other than node — that's a real SSH target.
  if (
    typeof cached.host === "string" &&
    typeof cached.node === "string" &&
    cached.host === cached.node &&
    cached.host !== "local" &&
    cached.host !== "localhost"
  ) {
    if (!warnedHostNodeConflated) {
      warnedHostNodeConflated = true;
      process.stderr.write(
        `[maw] config.host "${cached.host}" matches config.node — legacy init bug (#906). ` +
        `host is the SSH target, not the node identity. Resetting host to "local". ` +
        `Edit maw.config.json to silence this warning.\n`,
      );
    }
    cached.host = "local";
  }
  // #736 Phase 1.1 — pre-populate config.agents from fleet at loadConfig time
  // so federation routing (`maw hey <oracle>`) sees fleet-known targets even
  // before their first wake. Additive only: hand-tuned config.agents entries
  // are preserved. Failure swallowed: a fleet read glitch must not brick load.
  try {
    const merged = loadFleetAgents(cached.agents || {}, cached.node);
    if (Object.keys(merged).length > 0) cached.agents = merged;
  } catch {
    // Defensive — loadFleetAgents already swallows IO/parse errors, but if
    // anything unexpected escapes we'd rather load with the raw config than
    // fail to start at all.
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
  warnedHostMigrated = false;
  warnedHostNodeConflated = false;
}

/**
 * #820 — Refuse to write to the real ~/.config/maw/ when MAW_TEST_MODE is set.
 *
 * Background: a regression in test/isolated/fleet-doctor.test.ts (the autoFix
 * suite) mocked `loadConfig` but not `saveConfig`, so the lazy-required real
 * `saveConfig` corrupted the developer's `~/.config/maw/maw.config.json` with
 * test fixture content (markers: `https://mba.example`, `/tmp/nope`).
 *
 * Guard rule: when running under test mode (`MAW_TEST_MODE=1`), `saveConfig`
 * MUST refuse to write to the real homedir config path. The test harness is
 * expected to set `MAW_HOME` or `MAW_CONFIG_DIR` to a tmpdir; if that's not
 * done, throw loudly rather than silently corrupting state.
 */
const REAL_HOME_CONFIG = join(homedir(), ".config", "maw", "maw.config.json");

export function saveConfig(update: Partial<MawConfig>) {
  if (process.env.MAW_TEST_MODE === "1" && CONFIG_FILE === REAL_HOME_CONFIG) {
    throw new Error(
      `[maw] saveConfig refused: MAW_TEST_MODE=1 but CONFIG_FILE points at the real homedir ` +
      `(${CONFIG_FILE}). Set MAW_HOME or MAW_CONFIG_DIR to a sandbox before any state-touching ` +
      `import is resolved (see src/core/paths.ts). (#820)`,
    );
  }
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
