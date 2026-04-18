import { loadConfig } from "./load";

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function buildCommand(agentName: string): string {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

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
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` param kept for API compat + future use.
 */
export function buildCommandInDir(agentName: string, _cwd: string): string {
  return buildCommand(agentName);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
