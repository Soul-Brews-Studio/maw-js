import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { MawConfig } from "./types";
import type { EngineDef } from "./engine-def";
import { getChannelEnv, getChannelPermissionMode, getChannelPluginIds } from "../commands/shared/channel-loader";
import { defaultEngineNameForConfig, engineNamesForConfig, enginePatternKeysForConfig, isClaudeLikeEngine, resolveEngine } from "./engine-registry";

const DISCORD_CHANNEL_PLUGIN = "plugin:discord@claude-plugins-official";

export interface BuildCommandOpts {
  engine?: string;
  channels?: string[];
  channelEnv?: Record<string, string>;
  devChannels?: boolean;
  permissionMode?: "skip" | "relay";
  /** Force a fresh launch form by removing engine resume/continue placeholders when possible. */
  fresh?: boolean;
  /** Optional model value for engines that declare a model flag. */
  model?: string;
  /** Optional system prompt file path for engines that support that launch form. */
  systemPromptFile?: string;
  /** @internal: set when channels came from repo/global channel config rather than explicit opts. */
  channelConfigLoaded?: boolean;
}

export type BuildCommandInput = string | BuildCommandOpts | undefined;

function normalizeBuildCommandOpts(input?: BuildCommandInput): BuildCommandOpts {
  return typeof input === "string" ? { engine: input } : { ...(input || {}) };
}

function hasChannelsFlag(cmd: string): boolean {
  return /\s--channels(?:\s|=|$)/.test(cmd);
}

function hasLongFlag(cmd: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\s${escaped}(?:\\s|=|$)`).test(cmd);
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

function applyChannelFlags(cmd: string, opts: BuildCommandOpts, engine: EngineDef | null, config: Partial<MawConfig>): string {
  const channels = opts.channels?.filter(Boolean) ?? [];
  if (!isClaudeLikeEngine(engine?.name, config)) return cmd;
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

function commandMatchNames(agentName: string): string[] {
  const names = [agentName];
  if (agentName && !agentName.endsWith("-oracle")) names.push(`${agentName}-oracle`);
  return names;
}

function matchesAgentPattern(pattern: string, agentName: string): boolean {
  return commandMatchNames(agentName).some((name) => matchGlob(pattern, name));
}

function shouldAutoDiscordChannels(cwd?: string): boolean {
  if (!cwd) return false;
  try { return existsSync(join(cwd, ".discord")); } catch { return false; }
}

function commandKeyForAgent(
  config: Partial<MawConfig>,
  agentName: string,
  opts: BuildCommandOpts,
): string {
  const keys = enginePatternKeysForConfig(config);
  const known = new Set(engineNamesForConfig(config));

  if (opts.engine && known.has(opts.engine)) return opts.engine;

  let key = defaultEngineNameForConfig(config);

  for (const pattern of keys) {
    if (pattern === "default") continue;
    if (matchesAgentPattern(pattern, agentName)) {
      key = pattern;
      break;
    }
  }

  return key;
}

function legacyConfig(config: Partial<MawConfig>): Partial<MawConfig> {
  return { ...config, engines: undefined };
}

function legacyCommandForAgent(
  config: Partial<MawConfig>,
  agentName: string,
  opts: BuildCommandOpts,
): string {
  return resolveEngine(commandKeyForAgent(legacyConfig(config), agentName, opts), legacyConfig(config)).cmd;
}

function selectEngineForAgent(
  config: Partial<MawConfig>,
  agentName: string,
  opts: BuildCommandOpts,
): EngineDef {
  return resolveEngine(commandKeyForAgent(config, agentName, opts), config);
}

function engineHas(engine: EngineDef | null, capability: string): boolean {
  return Boolean(engine?.capabilities?.includes(capability));
}

function applyFreshLaunch(cmd: string, engine: EngineDef | null, opts: BuildCommandOpts): string {
  if (!opts.fresh || !engine?.resume?.replaces || !engineHas(engine, "resume")) return cmd;
  const escaped = engine.resume.replaces.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cmd.replace(new RegExp(`\\s*${escaped}\\b`), "");
}

function applyModelFlag(cmd: string, engine: EngineDef | null, opts: BuildCommandOpts): string {
  const flag = engine?.model?.flag;
  if (!opts.model || !flag || !engineHas(engine, "model") || hasLongFlag(cmd, flag)) return cmd;
  return `${cmd} ${flag} ${opts.model}`;
}

function applySystemPromptFile(cmd: string, engine: EngineDef | null, opts: BuildCommandOpts): string {
  if (!opts.systemPromptFile || !engineHas(engine, "system-prompt-file") || hasLongFlag(cmd, "--system-prompt-file")) return cmd;
  return `${cmd} --system-prompt-file ${shellQuote(opts.systemPromptFile)}`;
}

function applyResumeFlag(cmd: string, engine: EngineDef | null, sessionId: string, genericRenderer: boolean): string {
  if (!genericRenderer) {
    if (cmd.includes("--continue")) return cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    return `${cmd} --resume "${sessionId}"`;
  }

  if (!engineHas(engine, "resume") || !engine?.resume?.flag) return cmd;
  const value = engine.resume.quoteValue === false ? sessionId : `"${sessionId}"`;
  if (engine.resume.replaces && cmd.includes(engine.resume.replaces)) {
    const escaped = engine.resume.replaces.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return cmd.replace(new RegExp(`\\s*${escaped}\\b`), ` ${engine.resume.flag} ${value}`);
  }
  return `${cmd} ${engine.resume.flag} ${value}`;
}

function addDiscordChannelsForClaude(cmd: string, engine: EngineDef | null, config: Partial<MawConfig>, cwd?: string): string {
  if (!shouldAutoDiscordChannels(cwd)) return cmd;
  if (hasChannelsFlag(cmd)) return cmd;
  if (!isClaudeLikeEngine(engine?.name, config)) return cmd;
  return `${cmd} --channels ${DISCORD_CHANNEL_PLUGIN}`;
}

export function buildCommandFromConfig(
  config: Partial<MawConfig> & { sessionIds?: Record<string, string> },
  agentName: string,
  optsOrEngine?: BuildCommandInput,
  context: { cwd?: string } = {},
): string {
  const opts = enrichOptionsFromChannelConfig(agentName, normalizeBuildCommandOpts(optsOrEngine), context.cwd);
  const genericRenderer = process.env.MAW_GENERIC_ENGINES !== "0";
  const engine = selectEngineForAgent(genericRenderer ? config : legacyConfig(config), agentName, opts);
  let cmd = genericRenderer
    ? engine.cmd
    : legacyCommandForAgent(config, agentName, opts);

  cmd = applyFreshLaunch(cmd, engine, opts);
  cmd = applyModelFlag(cmd, engine, opts);
  cmd = applySystemPromptFile(cmd, engine, opts);

  const commandOpts = opts.channelConfigLoaded && !isClaudeLikeEngine(engine.name, config)
    ? { ...opts, channels: [], channelEnv: undefined }
    : opts;

  if (commandOpts.channels?.length) {
    cmd = applyChannelFlags(cmd, commandOpts, engine, config);
  } else {
    cmd = addDiscordChannelsForClaude(cmd, engine, config, context.cwd);
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = config.sessionIds || {};
  const sessionId = commandMatchNames(agentName).map((name) => sessionIds[name]).find(Boolean)
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchesAgentPattern(p, agentName))?.[1];
  if (sessionId && !opts.fresh) {
    cmd = applyResumeFlag(cmd, engine, sessionId, genericRenderer);
  }

  cmd = applyChannelEnv(cmd, commandOpts.channelEnv);

  // Strip --dangerously-skip-permissions when running as root (#181), including
  // channel-loader injected skips.
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/g, "");
  }

  // #T069 — on Windows, claude-like engines need a `winpty` wrapper or they
  // drop into print mode and exit instead of running as an interactive TUI.
  // The prefix is a no-op on POSIX. `MAW_NO_WINPTY=1` lets users with custom
  // PTY setups (e.g. ConEmu, Windows Terminal) opt out.
  if (process.platform === "win32" && isClaudeLikeEngine(engine.name, config) && !process.env.MAW_NO_WINPTY) {
    cmd = `winpty ${cmd}`;
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
