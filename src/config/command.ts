import { loadConfig } from "./load";
import { buildCommandFromConfig, buildCommandInDirFromConfig, type BuildCommandInput } from "./command-logic";

export { buildCommandFromConfig, buildCommandInDirFromConfig, type BuildCommandInput, type BuildCommandOpts } from "./command-logic";

export function buildCommand(agentName: string, optsOrEngine?: BuildCommandInput): string {
  return buildCommandFromConfig(loadConfig(), agentName, optsOrEngine);
}

/**
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` now also drives repo-local launch
 * detection such as Discord bot `--channels` injection.
 */
export function buildCommandInDir(agentName: string, cwd: string, optsOrEngine?: BuildCommandInput): string {
  return buildCommandInDirFromConfig(loadConfig({ cwd }), agentName, cwd, optsOrEngine);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
