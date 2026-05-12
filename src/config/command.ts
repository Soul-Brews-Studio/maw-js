import { loadConfig } from "./load";
import { homedir } from "os";
import { writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { resolveHome } from "../core/paths";

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Channel config (`~/.claude/channels/<oracle>/config.json`) accepts paths
 * like `"~/.claude/channels/foo"` in env values. JSON has no shell, so the
 * tilde reaches `buildCommand` as a literal `~`. The env-prepend block
 * single-quotes values, which suppresses tilde expansion at exec time too,
 * so the plugin sees `DISCORD_STATE_DIR=~/.claude/...` literally and either
 * fails to find the dir or silently falls back to a default.
 *
 * Expand here, before quoting. Only triggers when `~` is the first character
 * and followed by `/` or end-of-string — won't touch usernames embedded
 * elsewhere in the value. (#1135)
 */
function expandTilde(value: string): string {
  return value.replace(/^~(?=\/|$)/, homedir());
}

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export interface BuildCommandOpts {
  engine?: string;
  channels?: string[];
  channelEnv?: Record<string, string>;
  devChannels?: boolean;
  /**
   * #1146 — gate `--dangerously-skip-permissions` injection for channel-enabled bots.
   *   "skip" (default) — inject the flag (current behavior, autonomous bots).
   *   "relay"          — omit the flag; permission prompts flow through the channel
   *                      (e.g. Discord DM ✅/❌ buttons via the MCP permission relay).
   * Only meaningful when `channels` is non-empty. Undefined ⇒ "skip" semantics
   * so existing setups are unchanged.
   */
  permissionMode?: "skip" | "relay";
}

export function buildCommand(agentName: string, optsOrEngine?: string | BuildCommandOpts): string {
  const opts: BuildCommandOpts = typeof optsOrEngine === "string"
    ? { engine: optsOrEngine }
    : (optsOrEngine || {});

  const config = loadConfig();
  let cmd: string;

  if (opts.engine && config.commands[opts.engine]) {
    // User config wins over registry defaults
    cmd = config.commands[opts.engine];
  } else if (opts.engine) {
    // #1205 — fall back to engine registry for interactive mode
    try {
      const { ENGINE_DEFS } = require("../commands/shared/engines");
      const engineDef = ENGINE_DEFS[opts.engine as keyof typeof ENGINE_DEFS];
      if (engineDef && engineDef.binary !== "claude") {
        const perm = engineDef.permissionFlag ? ` ${engineDef.permissionFlag}` : "";
        return `${engineDef.binary}${perm}`;
      }
    } catch {}
    cmd = config.commands.default || "claude";
  } else {
    cmd = config.commands.default || "claude";
    for (const [pattern, command] of Object.entries(config.commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
  }

  // Prepend channel env vars directly to command (not tmux set-environment)
  // because tmux set-environment only affects NEW shells, not the existing one.
  //
  // #1148 — defer to shell env when set. Precedence: shell env (non-empty)
  // wins over channel config.json. Empty-string env is treated as unset
  // (otherwise stale `export DISCORD_STATE_DIR=` would silently disable
  // the config value — same #1135 trap shape through a different door).
  if (opts.channelEnv && Object.keys(opts.channelEnv).length > 0) {
    const envPrefix = Object.entries(opts.channelEnv)
      .filter(([k]) => process.env[k] === undefined || process.env[k] === "")
      .map(([k, v]) => `${k}='${expandTilde(v).replace(/'/g, "'\\''")}'`)
      .join(" ");
    if (envPrefix) cmd = `${envPrefix} ${cmd}`;
  }

  if (opts.channels?.length) {
    cmd += " --channels " + opts.channels.join(" ");
    // #1108: channel-enabled oracles (Discord/Telegram bots) run autonomous —
    // permission prompts block unattended sessions (Mother stuck 20+ min).
    //
    // #1146: opt-out via permissionMode: "relay". When set, the bot keeps the
    // channel + --continue plumbing but the skip flag is omitted so that
    // permission prompts route through the channel (e.g. Discord DM ✅/❌).
    // Default (undefined or "skip") preserves the #1108 behavior.
    if (opts.permissionMode !== "relay" && !cmd.includes("--dangerously-skip-permissions")) {
      cmd += " --dangerously-skip-permissions";
    }
  }
  if (opts.devChannels) {
    cmd += " --dangerously-load-development-channels";
  }

  // #1174 — `--continue` is the default for ALL claude wakes (not just
  // channel-enabled bots), so `maw wake <oracle>` resumes the prior
  // conversation in that oracle's cwd instead of starting fresh.
  //
  // Engine-aware guard: only inject for `claude` commands. `codex` (and any
  // other non-claude engine in `commands.<engine>`) doesn't recognize
  // `--continue`, and the `||` fallback below only fires on non-zero exit —
  // codex may silently ignore unknown flags, never tripping the fallback.
  // The simplest safe rule: cmd must start with `claude` (after optional env-
  // var prefix from `channelEnv`).
  const cmdPart = cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|\S*)\s+)+/, "");
  const isClaudeEngine = cmdPart.startsWith("claude");
  if (
    isClaudeEngine &&
    !cmd.includes("--continue") &&
    !cmd.includes("--resume")
  ) {
    cmd += " --continue";
  }

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = config.sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // Plain command — no fallback wrap. The `claude()` shell wrapper from
  // `maw shellenv` handles `--continue` fallback transparently. Users without
  // the wrapper get a single attempt at --continue (sufficient for normal use).
  return cmd;
}

const SESSIONS_DIR = join(resolveHome(), "sessions");

function formatScriptHeader(agentName: string, cwd: string, opts: BuildCommandOpts): string {
  const lines = [
    `#!/usr/bin/env bash`,
    `# maw-session: ${agentName}`,
    `# Generated: ${new Date().toISOString()}`,
    `# Repo: ${cwd}`,
  ];
  if (opts.channels?.length) lines.push(`# Channel: ${opts.channels.join(", ")}`);
  if (opts.permissionMode) lines.push(`# Permission: ${opts.permissionMode}`);
  if (opts.engine) lines.push(`# Engine: ${opts.engine}`);
  lines.push("");
  lines.push(`clear`);
  lines.push(`printf '\\033]2;${agentName}\\033\\\\'`);
  lines.push(`date "+🕐 %H:%M %Z — ${agentName}"`);
  lines.push(`echo`);
  lines.push("");
  return lines.join("\n");
}

function formatScriptBody(agentName: string, opts: BuildCommandOpts): string {
  const config = loadConfig();
  const lines: string[] = [];

  if (opts.channelEnv && Object.keys(opts.channelEnv).length > 0) {
    const envEntries = Object.entries(opts.channelEnv)
      .filter(([k]) => process.env[k] === undefined || process.env[k] === "");
    if (envEntries.length) {
      for (const [k, v] of envEntries) {
        lines.push(`export ${k}='${expandTilde(v).replace(/'/g, "'\\''")}'`);
      }
      lines.push("");
    }
  }

  // #1205 — non-claude engines: simple interactive command from registry.
  let cmd: string;
  if (opts.engine && config.commands[opts.engine]) {
    // User config wins over registry
    cmd = config.commands[opts.engine];
  } else if (opts.engine) {
    // #1205 — fall back to engine registry for interactive script
    try {
      const { ENGINE_DEFS } = require("../commands/shared/engines");
      const e = ENGINE_DEFS[opts.engine as keyof typeof ENGINE_DEFS];
      if (e && e.binary !== "claude") {
        const perm = e.permissionFlag ? ` ${e.permissionFlag}` : "";
        lines.push(`which ${e.binary}`);
        lines.push("");
        lines.push(`${e.binary}${perm}`);
        lines.push("");
        lines.push("# Terminal reset");
        lines.push('printf "\\e[?1049l\\e[0m"');
        lines.push("stty sane 2>/dev/null");
        lines.push("clear");
        return lines.join("\n");
      }
    } catch {}
    cmd = config.commands.default || "claude";
  } else {
    cmd = config.commands.default || "claude";
    for (const [pattern, command] of Object.entries(config.commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
  }

  const flags: string[] = [];
  if (opts.channels?.length) {
    flags.push(`--channels ${opts.channels.join(" ")}`);
    if (opts.permissionMode !== "relay" && !cmd.includes("--dangerously-skip-permissions")) {
      flags.push("--dangerously-skip-permissions");
    }
  }
  if (opts.devChannels) flags.push("--dangerously-load-development-channels");

  const cmdPart = cmd;
  const isClaudeEngine = cmdPart.startsWith("claude");

  if (process.getuid?.() === 0) {
    const idx = flags.indexOf("--dangerously-skip-permissions");
    if (idx !== -1) flags.splice(idx, 1);
  }

  const sessionIds: Record<string, string> = config.sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];

  // Idempotency: don't double-append --continue/--resume if config.commands.default
  // already includes them. buildCommand() has the same guard; mirror it here.
  const alreadyHasContinue = cmd.includes("--continue") || cmd.includes("--resume");
  const fullCmd = [cmd, ...flags].join(" \\\n    ");

  // Surface which binary the pane is about to invoke — the shellenv wrapper
  // for `claude`, or the resolved PATH entry for codex/gemini/etc. Helps
  // debug shadowing, missing wrappers, and stale installs.
  const whichBinary = cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "").split(/\s+/)[0];
  if (whichBinary) {
    lines.push(`which ${whichBinary}`);
    lines.push("");
  }

  if (isClaudeEngine && !sessionId) {
    if (alreadyHasContinue) {
      // cmd already has --continue; build a fallback that strips it.
      const cmdNoCont = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+\S+/, "");
      const fallbackCmd = [cmdNoCont, ...flags].join(" \\\n    ");
      lines.push(`{ ${fullCmd} \\`);
      lines.push(`  || ${fallbackCmd}; }`);
    } else {
      const fallbackCmd = [cmd, ...flags].join(" \\\n    ");
      lines.push(`{ ${fullCmd} \\`);
      lines.push(`    --continue \\`);
      lines.push(`  || ${fallbackCmd}; }`);
    }
  } else if (sessionId) {
    // sessionId pin: replace --continue with --resume in the primary, fallback uses --session-id
    const cmdNoCont = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+\S+/, "");
    const primary = [cmdNoCont, ...flags].join(" \\\n    ");
    lines.push(`{ ${primary} \\`);
    lines.push(`    --resume "${sessionId}" \\`);
    lines.push(`  || ${primary} \\`);
    lines.push(`    --session-id "${sessionId}"; }`);
  } else {
    lines.push(fullCmd);
  }

  lines.push("");
  lines.push(`# Terminal reset — fixes Claude TUI raw mode + alternate screen (#1091)`);
  lines.push(`printf "\\e[?1049l\\e[0m"`);
  lines.push(`stty sane 2>/dev/null`);
  lines.push(`clear`);

  return lines.join("\n");
}

export function writeSessionScript(agentName: string, cwd: string, optsOrEngine?: string | BuildCommandOpts): string {
  const opts: BuildCommandOpts = typeof optsOrEngine === "string"
    ? { engine: optsOrEngine }
    : (optsOrEngine || {});

  mkdirSync(SESSIONS_DIR, { recursive: true });
  const scriptPath = join(SESSIONS_DIR, `${agentName}.sh`);
  const content = formatScriptHeader(agentName, cwd, opts) + formatScriptBody(agentName, opts) + "\n";
  writeFileSync(scriptPath, content, { mode: 0o755 });

  return scriptPath;
}

/**
 * Build the command string for a wake pane. Writes a session script to
 * ~/.maw/sessions/<agent>.sh and returns the command to run it (#1188).
 *
 * Falls back to inline buildCommand() if script write fails.
 */
export function buildCommandInDir(agentName: string, cwd: string, optsOrEngine?: string | BuildCommandOpts): string {
  try {
    const scriptPath = writeSessionScript(agentName, cwd, optsOrEngine);
    return ` bash ${scriptPath}`;
  } catch {
    return buildCommand(agentName, optsOrEngine);
  }
}

/**
 * Build the plain wake command for the pane.
 * No per-oracle function, no inline fallback wrap — relies on the
 * user's `claude()` shell wrapper (from `maw shellenv`) to handle
 * `--continue` fallback transparently.
 *
 * Pane shows the actual command: `claude --dangerously-skip-permissions --continue`
 * Re-runnable with up-arrow. Re-runnable by typing claude flags directly.
 */
export function buildShellFunction(agentName: string, optsOrEngine?: string | BuildCommandOpts): string {
  return buildCommand(agentName, optsOrEngine);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
