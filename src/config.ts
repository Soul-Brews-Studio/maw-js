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
  idleTimeoutMinutes?: number;
  federationToken?: string;
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
    const errors = validateConfig(raw);
    if (errors.length) {
      console.error(`\x1b[33m⚠ maw config warnings:\x1b[0m ${errors.join("; ")}`);
    }
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

/** Validate config shape with native TS checks (no Zod).
 *  Returns array of error strings — empty means valid. */
export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Config must be an object"];
  const c = config as Record<string, unknown>;

  if (c.host !== undefined && typeof c.host !== "string") errors.push("host must be a string");
  if (c.port !== undefined) {
    if (typeof c.port !== "number" || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
      errors.push("port must be an integer 1-65535");
  }
  if (c.ghqRoot !== undefined && typeof c.ghqRoot !== "string") errors.push("ghqRoot must be a string");
  if (c.oracleUrl !== undefined && typeof c.oracleUrl !== "string") errors.push("oracleUrl must be a string");
  if (c.tmuxSocket !== undefined && typeof c.tmuxSocket !== "string") errors.push("tmuxSocket must be a string");
  if (c.federationToken !== undefined && typeof c.federationToken !== "string") errors.push("federationToken must be a string");

  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) {
      errors.push("env must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`env.${k} must be a string`);
      }
    }
  }

  if (c.commands !== undefined) {
    if (!c.commands || typeof c.commands !== "object" || Array.isArray(c.commands)) {
      errors.push("commands must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.commands as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`commands.${k} must be a string`);
      }
    }
  }

  if (c.sessions !== undefined) {
    if (!c.sessions || typeof c.sessions !== "object" || Array.isArray(c.sessions)) {
      errors.push("sessions must be a Record<string, string>");
    } else {
      for (const [k, v] of Object.entries(c.sessions as Record<string, unknown>)) {
        if (typeof v !== "string") errors.push(`sessions.${k} must be a string`);
      }
    }
  }

  if (c.peers !== undefined) {
    if (!Array.isArray(c.peers)) {
      errors.push("peers must be a string[]");
    } else {
      for (let i = 0; i < c.peers.length; i++) {
        if (typeof c.peers[i] !== "string") errors.push(`peers[${i}] must be a string`);
      }
    }
  }

  return errors;
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
