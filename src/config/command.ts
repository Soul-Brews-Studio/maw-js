import { loadConfig } from "./load";

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
}

export function buildCommand(agentName: string, optsOrEngine?: string | BuildCommandOpts): string {
  const opts: BuildCommandOpts = typeof optsOrEngine === "string"
    ? { engine: optsOrEngine }
    : (optsOrEngine || {});
  const config = loadConfig();
  let cmd: string;

  if (opts.engine && config.commands[opts.engine]) {
    cmd = config.commands[opts.engine];
  } else {
    cmd = config.commands.default || "claude";
    for (const [pattern, command] of Object.entries(config.commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
  }

  // Prepend channel env vars directly to command (not tmux set-environment)
  // because tmux set-environment only affects NEW shells, not the existing one
  if (opts.channelEnv && Object.keys(opts.channelEnv).length > 0) {
    const envPrefix = Object.entries(opts.channelEnv)
      .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
      .join(" ");
    cmd = `${envPrefix} ${cmd}`;
  }

  if (opts.channels?.length) {
    cmd += " --channels " + opts.channels.join(" ");
    // #1108: channel-enabled oracles (Discord/Telegram bots) run autonomous —
    // permission prompts block unattended sessions (Mother stuck 20+ min).
    if (!cmd.includes("--dangerously-skip-permissions")) {
      cmd += " --dangerously-skip-permissions";
    }
    if (!cmd.includes("--continue") && !cmd.includes("--resume")) {
      cmd += " --continue";
    }
  }
  if (opts.devChannels) {
    cmd += " --dangerously-load-development-channels";
  }

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = (config as any).sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // Fallback for --continue/--resume: retry without it (fresh worktree / expired session).
  // Keep --session-id (if set) so the first run creates the session with that ID.
  // Reset terminal after Claude TUI exits — prevents frozen prompt (#1091)
  const reset = 'printf "\\e[?1049l\\e[0m"; stty sane 2>/dev/null; clear';

  if (cmd.includes("--continue") || cmd.includes("--resume")) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `{ ${cmd} || ${fallback}; }; ${reset}`;
  }

  return `${cmd}; ${reset}`;
}

/**
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` param kept for API compat + future use.
 */
export function buildCommandInDir(agentName: string, _cwd: string, optsOrEngine?: string | BuildCommandOpts): string {
  return buildCommand(agentName, optsOrEngine);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
