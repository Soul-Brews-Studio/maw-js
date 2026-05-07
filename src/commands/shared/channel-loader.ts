import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CHANNELS_BASE = join(homedir(), ".claude", "channels");

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
  return join(CHANNELS_BASE, oracleStem);
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

export function getChannelPluginIds(oracleStem: string, fleetOverride?: string[]): string[] {
  if (fleetOverride?.length) return fleetOverride;
  const config = loadOracleChannels(oracleStem);
  return config?.plugins.map(p => p.id) ?? [];
}

/**
 * #1146 — read the permissionMode from the channel config.
 * Returns "skip" when unset or the file is missing so callers can pass the
 * value straight through to buildCommand without an extra null-check.
 */
export function getChannelPermissionMode(oracleStem: string): "skip" | "relay" {
  const config = loadOracleChannels(oracleStem);
  return config?.permissionMode === "relay" ? "relay" : "skip";
}

export function getChannelEnv(oracleStem: string, fleetEnvOverride?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const config = loadOracleChannels(oracleStem);
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
  if (!existsSync(CHANNELS_BASE)) return [];
  const { readdirSync } = require("fs");
  const dirs = readdirSync(CHANNELS_BASE, { withFileTypes: true })
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
