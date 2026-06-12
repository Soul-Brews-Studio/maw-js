import type { MawConfig } from "./types";
import type { EngineDef } from "./engine-def";
import { UserError } from "../core/util/user-error";

/** Seed-only engine definitions for maw init/bootstrap. Runtime resolvers must not consult this. */
export const ENGINE_SEED = {
  claude: {
    name: "claude",
    cmd: "claude",
    label: "Claude Code",
    processNames: ["claude", "claude-code", "thclaude"],
    resume: { flag: "--resume", replaces: "--continue", quoteValue: true },
    model: { flag: "--model", default: "sonnet" },
    capabilities: ["channels", "resume", "model", "system-prompt-file"],
  },
  codex: { name: "codex", cmd: "codex", label: "Codex CLI", processNames: ["codex"] },
  omx: { name: "omx", cmd: "omx", label: "Oh My Codex", processNames: ["omx", "codex"] },
  thclaws: { name: "thclaws", cmd: "thclaws", label: "thClaws", processNames: ["thclaws"] },
  opencode: { name: "opencode", cmd: "opencode", label: "OpenCode", processNames: ["opencode"] },
  aider: { name: "aider", cmd: "aider", label: "Aider", processNames: ["aider"] },
} satisfies Record<string, EngineDef>;

/** @deprecated Use ENGINE_SEED for config seeding only; not used by runtime resolution. */
export const DEFAULT_ENGINES = ENGINE_SEED;

export type EngineRegistry = Record<string, EngineDef>;

export function isClaudeLikeCommand(cmd: string): boolean {
  return /(^|\s)(?:command\s+)?claude[A-Za-z0-9_-]*(?:\s|$)/.test(cmd);
}

function legacyCommandProcessName(cmd: string): string | undefined {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token === "env") continue;
    if (token === "command") return tokens[i + 1];
    return token;
  }
  return undefined;
}

function fromLegacyCommand(name: string, cmd: string): EngineDef {
  const builtIn = ENGINE_SEED[name];
  const bin = legacyCommandProcessName(cmd);
  const processNames = bin && bin !== "default"
    ? [...new Set([bin, ...(builtIn?.processNames ?? [])])]
    : builtIn?.processNames;
  const def: EngineDef = { name, cmd, ...(builtIn?.label ? { label: builtIn.label } : {}), processNames };
  if (isClaudeLikeCommand(cmd)) {
    def.resume = { flag: "--resume", replaces: "--continue", quoteValue: true };
    def.model = { flag: "--model", default: "sonnet" };
    def.capabilities = ["channels", "resume", "model", "system-prompt-file"];
  }
  return def;
}

/**
 * Resolve an engine definition without changing any launch behavior yet (#1960 P1).
 *
 * Precedence mirrors the planned migration contract:
 * config.engines[name] > legacy config.commands[name].
 *
 * ENGINE_SEED is intentionally excluded from runtime resolution (#2708). Fresh
 * installs persist seed entries into config.engines during maw init/bootstrap.
 */
export function resolveEngine(name: string, config: Partial<MawConfig> = {}): EngineDef {
  const configured = config.engines?.[name];
  if (configured) return { name, ...configured };

  const legacy = config.commands?.[name];
  if (legacy) return fromLegacyCommand(name, legacy);

  const known = engineNamesForConfig(config).sort().join(", ") || "none";
  throw new UserError(`engine '${name}' not resolvable — known: [${known}]; define it in config.engines/config.commands or run maw init to seed config.engines`);
}

export function engineNamesForConfig(config: Partial<MawConfig> = {}): string[] {
  return [...new Set([
    ...Object.keys(config.engines ?? {}),
    ...Object.keys(config.commands ?? {}),
  ])];
}

export function enginePatternKeysForConfig(config: Partial<MawConfig> = {}): string[] {
  return [...new Set([
    ...Object.keys(config.engines ?? {}),
    ...Object.keys(config.commands ?? {}),
  ])];
}

export function defaultEngineNameForConfig(config: Partial<MawConfig> = {}): string {
  if (config.engines?.default || config.commands?.default) return "default";
  if (config.defaultEngine) return config.defaultEngine;
  throw new UserError("no default engine configured");
}

export function isClaudeLikeEngine(name: string | undefined, config: Partial<MawConfig> = {}): boolean {
  const engineName = name?.trim();
  if (!engineName) return false;
  return resolveEngine(engineName, config).capabilities?.includes("system-prompt-file") ?? false;
}
