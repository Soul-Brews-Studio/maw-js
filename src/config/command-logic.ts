import type { MawConfig } from "./types";

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function buildCommandFromConfig(
  config: Partial<MawConfig> & { sessionIds?: Record<string, string> },
  agentName: string,
  engine?: string,
): string {
  const commands = config.commands || { default: "claude" };
  let cmd: string;

  if (engine && commands[engine]) {
    cmd = commands[engine];
  } else {
    cmd = commands.default || "claude";
    for (const [pattern, command] of Object.entries(commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
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

  // Fallback for --continue/--resume: retry without it (fresh worktree / expired session).
  // Keep --session-id (if set) so the first run creates the session with that ID.
  if (cmd.includes("--continue") || cmd.includes("--resume")) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `${cmd} || ${fallback}`;
  }

  return cmd;
}

/**
 * `cwd` param kept for API compatibility + future use. The command itself is
 * cwd-independent because tmux newWindow(cwd:) sets the initial pane cwd.
 */
export function buildCommandInDirFromConfig(
  config: Partial<MawConfig> & { sessionIds?: Record<string, string> },
  agentName: string,
  _cwd: string,
  engine?: string,
): string {
  return buildCommandFromConfig(config, agentName, engine);
}
