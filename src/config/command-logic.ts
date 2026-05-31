import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { MawConfig } from "./types";
import { getChannelEnv, getChannelPermissionMode, getChannelPluginIds } from "../commands/shared/channel-loader";
import { resolveEngine } from "./engine-registry";

const DISCORD_CHANNEL_PLUGIN = "plugin:discord@claude-plugins-official";

export interface BuildCommandOpts {
  engine?: string;
  channels?: string[];
  channelEnv?: Record<string, string>;
  devChannels?: boolean;
  permissionMode?: "skip" | "relay";
  /** @internal: set when channels came from repo/global channel config rather than explicit opts. */
  channelConfigLoaded?: boolean;
}

export type BuildCommandInput = string | BuildCommandOpts | undefined;

function normalizeBuildCommandOpts(input?: BuildCommandInput): BuildCommandOpts {
  return typeof input === "string" ? { engine: input } : { ...(input || {}) };
}

function isClaudeLikeCommand(cmd: string): boolean {
  return /(^|\s)(?:command\s+)?claude[A-Za-z0-9_-]*(?:\s|$)/.test(cmd);
}

function hasChannelsFlag(cmd: string): boolean {
  return /\s--channels(?:\s|=|$)/.test(cmd);
}

function expandLeadingTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function applyChannelEnv(cmd: string, channelEnv?: Record<string, string>): string {
  if (!channelEnv || Object.keys(channelEnv).length === 0) return cmd;
  const envPrefix = Object.entries(channelEnv)
    .filter(([key]) => process.env[key] === undefined || process.env[key] === "")
    .map(([key, value]) => `${key}=${shellQuote(expandLeadingTilde(String(value)))}`)
    .join(" ");
  return envPrefix ? `${envPrefix} ${cmd}` : cmd;
}

function enrichOptionsFromChannelConfig(
  agentName: string,
  opts: BuildCommandOpts,
  cwd?: string,
): BuildCommandOpts {
  if (opts.channels?.length || !cwd) return opts;
  const stems = Array.from(new Set([agentName.replace(/-oracle$/, ""), agentName]));
  for (const stem of stems) {
    const channels = getChannelPluginIds(stem, undefined, cwd);
    if (channels.length === 0) continue;
    return {
      ...opts,
      channels,
      channelEnv: { ...getChannelEnv(stem, undefined, cwd), ...(opts.channelEnv || {}) },
      permissionMode: opts.permissionMode ?? getChannelPermissionMode(stem, cwd),
      channelConfigLoaded: true,
    };
  }
  return opts;
}

function applyChannelFlags(cmd: string, opts: BuildCommandOpts): string {
  const channels = opts.channels?.filter(Boolean) ?? [];
  if (!isClaudeLikeCommand(cmd)) return cmd;
  if (channels.length > 0 && !hasChannelsFlag(cmd)) {
    cmd += ` --channels ${channels.join(" ")}`;
  }
  if (channels.length > 0 && opts.permissionMode !== "relay" && !cmd.includes("--dangerously-skip-permissions")) {
    cmd += " --dangerously-skip-permissions";
  }
  if (opts.devChannels && !cmd.includes("--dangerously-load-development-channels")) {
    cmd += " --dangerously-load-development-channels";
  }
  return cmd;
}

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

function shouldAutoDiscordChannels(cwd?: string): boolean {
  if (!cwd) return false;
  try { return existsSync(join(cwd, ".discord")); } catch { return false; }
}

function legacyCommandForAgent(
  config: Partial<MawConfig>,
  agentName: string,
  opts: BuildCommandOpts,
): string {
  const commands = config.commands || { default: "claude" };
  let cmd: string;

  if (opts.engine && commands[opts.engine]) {
    cmd = commands[opts.engine];
  } else {
    cmd = commands.default || "claude";
    for (const [pattern, command] of Object.entries(commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
  }

  return cmd;
}

function renderCommandFromEngine(
  config: Partial<MawConfig>,
  agentName: string,
  opts: BuildCommandOpts,
): string {
  const commands = config.commands || { default: "claude" };

  // Preserve the legacy "unknown explicit engine falls back to default/pattern"
  // behavior unless the new typed engine registry has an explicit entry.
  if (opts.engine && config.engines?.[opts.engine]) {
    return resolveEngine(opts.engine, config).cmd;
  }
  if (opts.engine && commands[opts.engine]) {
    return resolveEngine(opts.engine, config).cmd;
  }

  let engineName = "default";
  for (const pattern of Object.keys(commands)) {
    if (pattern === "default") continue;
    if (matchGlob(pattern, agentName)) { engineName = pattern; break; }
  }

  return resolveEngine(engineName, config).cmd;
}

function addDiscordChannelsForClaude(cmd: string, cwd?: string): string {
  if (!shouldAutoDiscordChannels(cwd)) return cmd;
  if (hasChannelsFlag(cmd)) return cmd;
  if (!isClaudeLikeCommand(cmd)) return cmd;
  return `${cmd} --channels ${DISCORD_CHANNEL_PLUGIN}`;
}

export function buildCommandFromConfig(
  config: Partial<MawConfig> & { sessionIds?: Record<string, string> },
  agentName: string,
  optsOrEngine?: BuildCommandInput,
  context: { cwd?: string } = {},
): string {
  const opts = enrichOptionsFromChannelConfig(agentName, normalizeBuildCommandOpts(optsOrEngine), context.cwd);
  let cmd = process.env.MAW_GENERIC_ENGINES === "0"
    ? legacyCommandForAgent(config, agentName, opts)
    : renderCommandFromEngine(config, agentName, opts);

  const commandOpts = opts.channelConfigLoaded && !isClaudeLikeCommand(cmd)
    ? { ...opts, channels: [], channelEnv: undefined }
    : opts;

  if (commandOpts.channels?.length) {
    cmd = applyChannelFlags(cmd, commandOpts);
  } else {
    cmd = addDiscordChannelsForClaude(cmd, context.cwd);
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

  cmd = applyChannelEnv(cmd, commandOpts.channelEnv);

  // Strip --dangerously-skip-permissions when running as root (#181), including
  // channel-loader injected skips.
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/g, "");
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
  cwd: string,
  optsOrEngine?: BuildCommandInput,
): string {
  return buildCommandFromConfig(config, agentName, optsOrEngine, { cwd });
}
