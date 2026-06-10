import type { MawConfig } from "./types";
import type { EngineDef } from "./engine-def";

/** @deprecated Seed-only defaults. Prefer resolveEngine()/engineNamesForConfig(). */
export const DEFAULT_ENGINES = {
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
  thclaws: { name: "thclaws", cmd: "thclaws", label: "thClaws", processNames: ["thclaws"] },
  opencode: { name: "opencode", cmd: "opencode", label: "OpenCode", processNames: ["opencode"] },
  aider: { name: "aider", cmd: "aider", label: "Aider", processNames: ["aider"] },
} satisfies Record<string, EngineDef>;

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
  const builtIn = DEFAULT_ENGINES[name];
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
 * config.engines[name] > legacy config.commands[name] > DEFAULT_ENGINES[name] >
 * a raw command named like the requested engine.
 */
export function resolveEngine(name: string, config: Partial<MawConfig> = {}): EngineDef {
  const configured = config.engines?.[name];
  if (configured) return { name, ...configured };

  const legacy = config.commands?.[name];
  if (legacy) return fromLegacyCommand(name, legacy);

  const builtIn = DEFAULT_ENGINES[name];
  if (builtIn) return { ...builtIn };

  return { name, cmd: name };
}

export function engineNamesForConfig(config: Partial<MawConfig> = {}): string[] {
  return [...new Set([
    ...Object.keys(config.engines ?? {}),
    ...Object.keys(config.commands ?? {}),
    ...Object.keys(DEFAULT_ENGINES),
  ])];
}

export function enginePatternKeysForConfig(config: Partial<MawConfig> = {}): string[] {
  return [...new Set([
    ...Object.keys(config.engines ?? {}),
    ...Object.keys(config.commands ?? {}),
  ])];
}

export function defaultEngineNameForConfig(config: Partial<MawConfig> = {}): string {
  return (config.engines?.default || config.commands?.default)
    ? "default"
    : (config.defaultEngine ?? "claude");
}

export function isClaudeLikeEngine(name: string | undefined, config: Partial<MawConfig> = {}): boolean {
  const engineName = name?.trim();
  if (!engineName) return false;
  return resolveEngine(engineName, config).capabilities?.includes("system-prompt-file") ?? false;
}
