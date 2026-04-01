import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { CONFIG_FILE } from "./paths";

function detectGhqRoot(): string {
  try { return execSync("ghq root", { encoding: "utf-8" }).trim(); }
  catch { return join(require("os").homedir(), "Code/github.com"); }
}

export type TriggerEvent = "issue-close" | "pr-merge" | "agent-idle" | "agent-wake" | "agent-crash";

export interface TriggerConfig {
  on: TriggerEvent;
  repo?: string;       // filter by repo (for issue-close, pr-merge)
  timeout?: number;     // seconds (for agent-idle)
  action: string;       // shell command to execute — supports {agent}, {repo}, {issue} templates
  name?: string;        // optional human label
}

/** Named peer with URL */
export interface PeerConfig {
  name: string;
  url: string;
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
  autoRestart?: boolean;
  triggers?: TriggerConfig[];
  /** Node identity (e.g. "white", "mba") */
  node?: string;
  /** Named peers with URLs */
  namedPeers?: PeerConfig[];
  /** Agent → node mapping (e.g. { "homekeeper": "mba", "neo": "white" }) */
  agents?: Record<string, string>;
  /** MQTT broker config */
  mqtt?: { broker: string; clientId?: string; username?: string; password?: string; selfName?: string; selfHost?: string };
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

/** Validate config values, warn on invalid fields, return sanitized config */
function validateConfig(raw: Record<string, unknown>): Partial<MawConfig> {
  const result: Record<string, unknown> = {};
  const warn = (field: string, msg: string) =>
    console.warn(`[maw] config warning: ${field} ${msg}, using default`);

  // host: string, non-empty
  if ("host" in raw) {
    if (typeof raw.host === "string" && raw.host.trim().length > 0) {
      result.host = raw.host.trim();
    } else {
      warn("host", "must be a non-empty string");
    }
  }

  // port: number, 1-65535
  if ("port" in raw) {
    const p = Number(raw.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      result.port = p;
    } else {
      warn("port", "must be an integer 1-65535");
    }
  }

  // ghqRoot: string
  if ("ghqRoot" in raw) {
    if (typeof raw.ghqRoot === "string" && raw.ghqRoot.length > 0) {
      result.ghqRoot = raw.ghqRoot;
    } else {
      warn("ghqRoot", "must be a non-empty string");
    }
  }

  // oracleUrl: string
  if ("oracleUrl" in raw) {
    if (typeof raw.oracleUrl === "string" && raw.oracleUrl.length > 0) {
      result.oracleUrl = raw.oracleUrl;
    } else {
      warn("oracleUrl", "must be a non-empty string");
    }
  }

  // env: Record<string, string>
  if ("env" in raw) {
    if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
      result.env = raw.env;
    } else {
      warn("env", "must be an object");
    }
  }

  // commands: Record<string, string>, must have "default" if present
  if ("commands" in raw) {
    if (raw.commands && typeof raw.commands === "object" && !Array.isArray(raw.commands)) {
      const cmds = raw.commands as Record<string, unknown>;
      if (!("default" in cmds) || typeof cmds.default !== "string") {
        warn("commands", "must include a 'default' string entry");
      } else {
        result.commands = cmds as Record<string, string>;
      }
    } else {
      warn("commands", "must be an object");
    }
  }

  // sessions: Record<string, string>
  if ("sessions" in raw) {
    if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      result.sessions = raw.sessions;
    } else {
      warn("sessions", "must be an object");
    }
  }

  // tmuxSocket: string if present
  if ("tmuxSocket" in raw) {
    if (typeof raw.tmuxSocket === "string") {
      result.tmuxSocket = raw.tmuxSocket;
    } else {
      warn("tmuxSocket", "must be a string");
    }
  }

  // triggers: TriggerConfig[]
  if ("triggers" in raw) {
    if (Array.isArray(raw.triggers)) {
      const valid = raw.triggers.filter((t: any) => {
        if (!t || typeof t !== "object") return false;
        if (!t.on || typeof t.on !== "string") return false;
        if (!t.action || typeof t.action !== "string") return false;
        return true;
      });
      if (valid.length !== raw.triggers.length) {
        warn("triggers", `has ${raw.triggers.length - valid.length} invalid entries, keeping valid ones`);
      }
      result.triggers = valid;
    } else {
      warn("triggers", "must be an array");
    }
  }

  // federationToken: string, min 16 chars
  if ("federationToken" in raw) {
    if (typeof raw.federationToken === "string" && raw.federationToken.length >= 16) {
      result.federationToken = raw.federationToken;
    } else if (typeof raw.federationToken === "string") {
      warn("federationToken", "must be at least 16 characters");
    } else {
      warn("federationToken", "must be a string");
    }
  }

  // pin: string if present
  if ("pin" in raw) {
    if (typeof raw.pin === "string") {
      result.pin = raw.pin;
    } else {
      warn("pin", "must be a string");
    }
  }

  // node: string if present
  if ("node" in raw) {
    if (typeof raw.node === "string" && raw.node.trim().length > 0) {
      result.node = raw.node.trim();
    } else {
      warn("node", "must be a non-empty string");
    }
  }

  // namedPeers: array of {name, url} objects
  if ("namedPeers" in raw) {
    if (Array.isArray(raw.namedPeers)) {
      const valid = raw.namedPeers.filter((p: any) => {
        if (!p || typeof p !== "object") return false;
        if (typeof p.name !== "string" || typeof p.url !== "string") return false;
        try { new URL(p.url); return true; } catch { return false; }
      });
      if (valid.length !== raw.namedPeers.length) {
        warn("namedPeers", `has ${raw.namedPeers.length - valid.length} invalid entries`);
      }
      result.namedPeers = valid;
    } else {
      warn("namedPeers", "must be an array of {name, url}");
    }
  }

  // agents: Record<string, string> (agent name → node name)
  if ("agents" in raw) {
    if (raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)) {
      result.agents = raw.agents;
    } else {
      warn("agents", "must be an object mapping agent names to node names");
    }
  }

  // mqtt: object with broker URL
  if ("mqtt" in raw) {
    if (raw.mqtt && typeof raw.mqtt === "object" && !Array.isArray(raw.mqtt)) {
      result.mqtt = raw.mqtt;
    } else {
      warn("mqtt", "must be an object with broker URL");
    }
  }

  // peers: array of valid URLs if present
  if ("peers" in raw) {
    if (Array.isArray(raw.peers)) {
      const valid = raw.peers.filter((p) => {
        if (typeof p !== "string") return false;
        try { new URL(p); return true; } catch { return false; }
      });
      if (valid.length !== raw.peers.length) {
        warn("peers", `has ${raw.peers.length - valid.length} invalid URL(s), keeping valid ones`);
      }
      result.peers = valid;
    } else {
      warn("peers", "must be an array of URLs");
    }
  }

  return result as Partial<MawConfig>;
}

export function loadConfig(): MawConfig {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    const validated = validateConfig(raw);
    cached = { ...DEFAULTS, ...validated };
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
export function validateConfigShape(config: unknown): string[] {
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
  const result: any = { ...config, env: {}, envMasked };
  // Mask federation token (show first 4 chars only)
  if (result.federationToken) {
    result.federationToken = result.federationToken.slice(0, 4) + "\u2022".repeat(12);
  }
  return result;
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

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = (config as any).sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    // Use --resume with fixed session ID (--session-id locks, --resume doesn't)
    // Replace --continue with --resume <uuid> if present, otherwise append
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // Prefix: load direnv (if present) + clear stale CLAUDECODE.
  // direnv allow + export ensures .envrc env vars load before Claude starts,
  // since tmux send-keys can race with the shell's direnv hook.
  // unset CLAUDECODE prevents "cannot be launched inside another" from crashed sessions.
  const prefix = "command -v direnv >/dev/null && direnv allow . && eval \"$(direnv export zsh)\"; unset CLAUDECODE 2>/dev/null;";

  // If command uses --continue or --resume, add shell fallback without it.
  // --continue errors when no prior conversation exists (e.g. fresh worktree,
  // wiped session). --resume errors when session ID doesn't exist yet.
  // The fallback retries the same command minus --continue/--resume,
  // but keeps --session-id if present so the first run creates the session with that ID.
  if (cmd.includes("--continue") || cmd.includes("--resume")) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `${prefix} ${cmd} || ${prefix} ${fallback}`;
  }

  return `${prefix} ${cmd}`;
}

/** Get env vars from config (for tmux set-environment) */
export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
