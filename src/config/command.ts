import { loadConfig } from "./load";
import { buildCommandFromConfig, buildCommandInDirFromConfig } from "./command-logic";

export { buildCommandFromConfig, buildCommandInDirFromConfig } from "./command-logic";

export function buildCommand(agentName: string, engine?: string): string {
  return buildCommandFromConfig(loadConfig(), agentName, engine);
}

/**
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` param kept for API compat + future use.
 */
export function buildCommandInDir(agentName: string, cwd: string, engine?: string): string {
  return buildCommandInDirFromConfig(loadConfig(), agentName, cwd, engine);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
