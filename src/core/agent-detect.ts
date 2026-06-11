import { ENGINE_SEED, engineNamesForConfig, resolveEngine } from "../config/engine-registry";
import type { EngineDef } from "../config/engine-def";
import type { MawConfig } from "../config/types";

const GENERIC_AGENT_PROCESS_NAMES = ["node"] as const;

function firstCommandToken(cmd: string | undefined): string {
  return (cmd ?? "").trim().split(/\s+/)[0] ?? "";
}

function commandBasename(cmd: string): string {
  return firstCommandToken(cmd).split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function normalizedProcessNames(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = commandBasename(name).trim().toLowerCase();
    if (normalized && normalized !== "default") seen.add(normalized);
  }
  return [...seen];
}

function processNamesFromEngine(def: EngineDef | undefined): string[] {
  return normalizedProcessNames(def?.processNames ?? []);
}

/**
 * Read-only agent-pane detection is deliberately lenient: it uses ENGINE_SEED
 * process names as a baseline even when config is unavailable or empty. This is
 * classification only, not launch resolution; spawn paths still call
 * resolveEngine() and remain config-only/fail-loud (#2708).
 */
export function agentProcessNames(config?: Partial<MawConfig> | null): string[] {
  const cfg = config ?? {};
  const names: string[] = Object.values(ENGINE_SEED).flatMap(processNamesFromEngine);
  for (const name of engineNamesForConfig(cfg)) {
    try {
      names.push(...processNamesFromEngine(resolveEngine(name, cfg)));
    } catch {
      // Detection must tolerate partial/bad config and config-load failures.
    }
  }
  return normalizedProcessNames(names);
}

function loadConfigLazy(): Partial<MawConfig> | null {
  try {
    const { loadConfig } = require("../config/load") as typeof import("../config/load");
    return loadConfig();
  } catch {
    return null;
  }
}

function loadConfiguredProcessNames(): string[] {
  return agentProcessNames(loadConfigLazy());
}

export function matchesAgentProcessName(cmd: string | null | undefined, processNames: readonly string[] = loadConfiguredProcessNames()): boolean {
  const raw = (cmd ?? "").trim();
  if (!raw) return false;
  const names = normalizedProcessNames(processNames);
  if (names.length === 0) return false;
  return raw
    .split(/\s+/)
    .map(token => commandBasename(token).toLowerCase())
    .some(token => token && names.includes(token));
}

/** Idle prompt strings that engines render while waiting for user input. */
export function engineIdlePromptPatterns(config?: Partial<MawConfig> | null): RegExp[] {
  const escaped = agentProcessNames(config)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return [];
  return [new RegExp(`ask (?:${escaped.join("|")})\\??\\s*$`, "i")];
}

function loadEngineIdlePromptPatterns(): RegExp[] {
  return engineIdlePromptPatterns(loadConfigLazy());
}

export function matchesEngineIdlePrompt(output: string | null | undefined): boolean {
  const normalized = (output ?? "").trim();
  if (!normalized) return false;
  return loadEngineIdlePromptPatterns().some(pattern => pattern.test(normalized));
}

/**
 * Decide whether a tmux pane's `pane_current_command` looks like an
 * agent runtime.
 *
 * Detection layers (any match → true):
 *  1. Engine registry `processNames` (config.engines primary, legacy
 *     config.commands shims, then built-in defaults).
 *  2. Legacy command executable names are included through resolveEngine().
 *  3. Generic node wrapper panes.
 *  4. Claude Code 2.1+ version command strings (e.g. `2.1.121`).
 */
export function isAgentCommandForConfig(cmd: string | null | undefined, config?: Partial<MawConfig> | null): boolean {
  const c = (cmd ?? "").trim();
  if (!c) return false;
  if (matchesAgentProcessName(c, agentProcessNames(config))) return true;
  if (matchesAgentProcessName(c, GENERIC_AGENT_PROCESS_NAMES)) return true;
  if (/^\d+\.\d+\.\d+$/.test(commandBasename(c))) return true;
  return false;
}

export function isAgentCommand(cmd: string | null | undefined): boolean {
  return isAgentCommandForConfig(cmd, loadConfigLazy());
}
