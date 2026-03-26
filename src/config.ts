import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { CONFIG_FILE } from "./paths";

function detectGhqRoot(): string {
  try { return execSync("ghq root", { encoding: "utf-8" }).trim(); }
  catch { return join(require("os").homedir(), "Code/github.com"); }
}

export interface MawConfig {
  host: string;
  port: number;
  ghqRoot: string;
  oracleUrl: string;
  env: Record<string, string>;
  commands: Record<string, string>;
  sessions: Record<string, string>;
  tmuxSocket?: string;
  peers?: string[];
}

const DEFAULTS: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: detectGhqRoot(),
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
};

let cached: MawConfig | null = null;

export function loadConfig(): MawConfig {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    cached = { ...DEFAULTS, ...raw };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/** Reset cached config (for hot-reload or testing) */
export function resetConfig() {
  cached = null;
}

/** Write config to maw.config.json and reset cache */
export function saveConfig(update: Partial<MawConfig>) {
  const current = loadConfig();
  const merged = { ...current, ...update };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  resetConfig(); // clear cache so next loadConfig() reads fresh
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
  return { ...config, env: {}, envMasked };
}

/** Simple glob match: supports * at start/end (e.g., "*-oracle", "codex-*") */
function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

/** Build the full command string for an agent (no env vars — use setSessionEnv) */
export function buildCommand(agentName: string): string {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";

  // Match specific patterns first (skip "default")
  for (const [pattern, command] of Object.entries(config.commands)) {
    if (pattern === "default") continue;
    if (matchGlob(pattern, agentName)) { cmd = command; break; }
  }

  // Prefix: load direnv (if present) + clear stale CLAUDECODE.
  // direnv allow + export ensures .envrc env vars load before Claude starts,
  // since tmux send-keys can race with the shell's direnv hook.
  // unset CLAUDECODE prevents "cannot be launched inside another" from crashed sessions.
  const prefix = "command -v direnv >/dev/null && direnv allow . && eval \"$(direnv export zsh)\"; unset CLAUDECODE 2>/dev/null;";

  // If command uses --continue, add shell fallback without it.
  // --continue errors when no prior conversation exists (e.g. fresh worktree,
  // wiped session). The fallback retries the same command minus --continue.
  if (cmd.includes("--continue")) {
    const fallback = cmd.replace(/\s*--continue\b/, "");
    return `${prefix} ${cmd} || ${prefix} ${fallback}`;
  }

  return `${prefix} ${cmd}`;
}

/** Get env vars from config (for tmux set-environment) */
export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
