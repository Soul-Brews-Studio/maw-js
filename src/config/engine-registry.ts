import type { MawConfig } from "./types";
import type { EngineDef } from "./engine-def";

export const DEFAULT_ENGINES = {
  claude: {
    name: "claude",
    cmd: "claude",
    label: "Claude Code",
    resume: { flag: "--resume", replaces: "--continue", quoteValue: true },
    model: { flag: "--model", default: "sonnet" },
    capabilities: ["channels", "resume", "model", "system-prompt-file"],
  },
  codex: { name: "codex", cmd: "codex", label: "Codex CLI" },
  opencode: { name: "opencode", cmd: "opencode", label: "OpenCode" },
  aider: { name: "aider", cmd: "aider", label: "Aider" },
} satisfies Record<string, EngineDef>;

export type EngineRegistry = Record<string, EngineDef>;

function isClaudeLikeCommand(cmd: string): boolean {
  return /(^|\s)(?:command\s+)?claude[A-Za-z0-9_-]*(?:\s|$)/.test(cmd);
}

function fromLegacyCommand(name: string, cmd: string): EngineDef {
  const builtIn = DEFAULT_ENGINES[name];
  const def: EngineDef = { name, cmd, ...(builtIn?.label ? { label: builtIn.label } : {}) };
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
