import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Defer HOME lookup to call-time. Evaluating this at module load froze the
 * developer's actual `$HOME` into a const, which made `process.env.HOME =
 * sandbox` in test `beforeAll` a no-op — tests then leaked
 * `test-*-oracle` dirs into the real `~/.claude/channels/`. (#1195 Phase 3)
 */
function channelsBase(): string {
  return join(homedir(), ".claude", "channels");
}

/**
 * Per-repo channel config path (#1195 Phase 1).
 * Lives at <repoPath>/.claude/channel.json — config travels with the repo,
 * eliminating cross-user/cross-machine migration pain.
 */
function repoConfigPath(repoPath: string): string {
  return join(repoPath, ".claude", "channel.json");
}

/** Save channel config to a repo's .claude/channel.json instead of global. */
export function saveRepoChannels(repoPath: string, config: OracleChannelConfig): void {
  const dir = join(repoPath, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(repoConfigPath(repoPath), JSON.stringify(config, null, 2) + "\n");

  // Auto-add .claude/.env to .gitignore (tokens never get committed)
  const gitignore = join(repoPath, ".gitignore");
  const entry = ".claude/.env";
  let needsAdd = true;
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, "utf8");
    if (content.split("\n").some(l => l.trim() === entry)) needsAdd = false;
  }
  if (needsAdd) {
    appendFileSync(gitignore, `\n# Channel bot token — never commit\n${entry}\n`);
  }
}

/** Read channel config from repo's .claude/channel.json. Returns null if missing. */
export function loadRepoChannels(repoPath: string): OracleChannelConfig | null {
  const p = repoConfigPath(repoPath);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export interface ChannelPlugin {
  id: string;
  env?: Record<string, string>;
}

export interface OracleChannelConfig {
  plugins: ChannelPlugin[];
  token_source?: string;
  /**
   * #1146 — permission gating mode for the wake command injection.
   *   "skip"  (default) — inject `--dangerously-skip-permissions` (autonomous).
   *   "relay"           — omit the skip flag so permission prompts flow through
   *                       the channel (e.g. Discord DM ✅/❌ via MCP relay).
   * Omitting the field preserves the existing #1108 autonomous behavior.
   */
  permissionMode?: "skip" | "relay";
}

function stateDir(oracleStem: string): string {
  return join(channelsBase(), oracleStem);
}

function configPath(oracleStem: string): string {
  return join(stateDir(oracleStem), "config.json");
}

export function loadOracleChannels(oracleStem: string): OracleChannelConfig | null {
  const p = configPath(oracleStem);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function saveOracleChannels(oracleStem: string, config: OracleChannelConfig): void {
  const dir = stateDir(oracleStem);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(oracleStem), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Resolve the effective channel config for an oracle.
 *
 * Phase 2 of #1195 — repo-local `.claude/channel.json` (if present at
 * `repoPath`) wins over the global `~/.claude/channels/<stem>/config.json`,
 * so config travels with the repo across machines and users. The global
 * path remains the fallback for un-migrated oracles.
 */
export function loadEffectiveChannels(
  oracleStem: string,
  repoPath?: string,
): OracleChannelConfig | null {
  if (repoPath) {
    const repo = loadRepoChannels(repoPath);
    if (repo) return repo;
  }
  return loadOracleChannels(oracleStem);
}

export function getChannelPluginIds(
  oracleStem: string,
  fleetOverride?: string[],
  repoPath?: string,
): string[] {
  if (fleetOverride?.length) return fleetOverride;
  return loadEffectiveChannels(oracleStem, repoPath)?.plugins.map(p => p.id) ?? [];
}

/**
 * #1146 — read the permissionMode from the channel config.
 * Returns "skip" when unset or the file is missing so callers can pass the
 * value straight through to buildCommand without an extra null-check.
 * `repoPath` is honored per #1195 Phase 2.
 */
export function getChannelPermissionMode(
  oracleStem: string,
  repoPath?: string,
): "skip" | "relay" {
  const config = loadEffectiveChannels(oracleStem, repoPath);
  return config?.permissionMode === "relay" ? "relay" : "skip";
}

export function getChannelEnv(
  oracleStem: string,
  fleetEnvOverride?: Record<string, string>,
  repoPath?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const config = loadEffectiveChannels(oracleStem, repoPath);
  if (config?.plugins) {
    for (const p of config.plugins) {
      if (p.env) Object.assign(env, p.env);
    }
  }
  if (fleetEnvOverride) Object.assign(env, fleetEnvOverride);

  // Expand tilde in env values
  const home = homedir();
  for (const [k, v] of Object.entries(env)) {
    if (v.startsWith("~/")) env[k] = join(home, v.slice(2));
  }

  // Resolve pass: token source → inject as env var
  if (config?.token_source?.startsWith("pass:")) {
    const passKey = config.token_source.slice(5);
    try {
      const { execSync } = require("child_process");
      const token = execSync(`pass show ${passKey}`, { encoding: "utf8", timeout: 5000 }).trim();
      if (token) {
        // Detect token type from plugin IDs
        const hasDiscord = config.plugins.some(p => p.id.includes("discord"));
        const hasTelegram = config.plugins.some(p => p.id.includes("telegram"));
        if (hasDiscord) env.DISCORD_BOT_TOKEN = token;
        else if (hasTelegram) env.TELEGRAM_BOT_TOKEN = token;
        else env.CHANNEL_TOKEN = token;
      }
    } catch { /* pass not available or key not found — skip silently */ }
  }

  return env;
}

export function listAllOracleChannels(): Array<{ oracle: string; plugins: ChannelPlugin[] }> {
  if (!existsSync(channelsBase())) return [];
  const { readdirSync } = require("fs");
  const dirs = readdirSync(channelsBase(), { withFileTypes: true })
    .filter((d: any) => d.isDirectory())
    .map((d: any) => d.name);

  const results: Array<{ oracle: string; plugins: ChannelPlugin[] }> = [];
  for (const dir of dirs) {
    const config = loadOracleChannels(dir);
    if (config?.plugins?.length) {
      results.push({ oracle: dir, plugins: config.plugins });
    }
  }
  return results;
}
