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

function fromLegacyCommand(name: string, cmd: string): EngineDef {
  const builtIn = DEFAULT_ENGINES[name];
  const bin = cmd.trim().split(/\s+/)[0];
  const def: EngineDef = { name, cmd, ...(builtIn?.label ? { label: builtIn.label } : {}), processNames: bin && bin !== "default" ? [bin] : builtIn?.processNames };
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
