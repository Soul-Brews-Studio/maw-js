/**
 * Type-safe AI engine registry (#1201).
 *
 * Uses `as const` (viem/abitype pattern) so TypeScript derives EngineName
 * union, default models, and binary names from the data — adding an engine
 * is one line, zero type definitions to update.
 */

/** Engine definitions — the single source of truth. */
export const ENGINE_DEFS = {
  claude: {
    binary: "claude",
    defaultModel: "sonnet",
    permissionFlag: "--dangerously-skip-permissions",
    promptMode: "file" as const,
  },
  codex: {
    binary: "codex",
    defaultModel: "gpt-5.5",
    permissionFlag: "-c approval_policy=never",
    promptMode: "stdin" as const,
  },
  gemini: {
    binary: "gemini",
    defaultModel: "gemini-2.5-pro",
    permissionFlag: "--sandbox",
    promptMode: "stdin" as const,
  },
  opencode: {
    binary: "opencode",
    defaultModel: "sonnet",
    permissionFlag: "",
    promptMode: "stdin" as const,
  },
  aider: {
    binary: "aider",
    defaultModel: "sonnet",
    permissionFlag: "--yes-always",
    promptMode: "file" as const,
  },
} as const;

/** Union of all registered engine names — auto-derived from ENGINE_DEFS. */
export type EngineName = keyof typeof ENGINE_DEFS;

/** Config shape for a specific engine. */
export type EngineConfig<T extends EngineName = EngineName> = (typeof ENGINE_DEFS)[T];

/** All registered engine names as a runtime array. */
export const ENGINE_NAMES = Object.keys(ENGINE_DEFS) as EngineName[];

/** Narrow a runtime string to EngineName or throw. */
export function resolveEngine(name: string): EngineName {
  if (name in ENGINE_DEFS) return name as EngineName;
  throw new Error(
    `Unknown engine '${name}'. Available: ${ENGINE_NAMES.join(", ")}`,
  );
}

/** Check if an engine's binary is installed. */
export function isEngineInstalled(engine: EngineName): boolean {
  try {
    const { execSync } = require("child_process");
    execSync(`which ${ENGINE_DEFS[engine].binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the default engine via override chain (#1205):
 *   1. $MAW_ENGINE env var (highest — CI, scripts)
 *   2. <repoPath>/.claude/engine.json → { "engine": "codex" }
 *   3. maw.config.json → { "defaultEngine": "codex" }
 *   4. "claude" (lowest — the built-in default)
 */
export function resolveDefaultEngine(repoPath?: string): EngineName {
  // 1. Env override
  const envEngine = process.env.MAW_ENGINE;
  if (envEngine && envEngine in ENGINE_DEFS) return envEngine as EngineName;

  // 2. Per-repo config
  if (repoPath) {
    try {
      const { existsSync, readFileSync } = require("fs");
      const { join } = require("path");
      const configPath = join(repoPath, ".claude", "engine.json");
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf8"));
        if (cfg.engine && cfg.engine in ENGINE_DEFS) return cfg.engine as EngineName;
      }
    } catch {}
  }

  // 3. Global config (lazy-import to avoid circular dep with config module)
  try {
    const { loadConfig } = require("../../config");
    const globalEngine = loadConfig().defaultEngine;
    if (globalEngine && globalEngine in ENGINE_DEFS) return globalEngine as EngineName;
  } catch {}

  // 4. Built-in default
  return "claude";
}

/** Build a shell command to invoke an engine with a prompt file. */
export function buildEngineCommand<T extends EngineName>(
  engine: T,
  opts: { model?: string; promptPath: string },
): string {
  const config = ENGINE_DEFS[engine];
  const model = opts.model ?? config.defaultModel;
  const escaped = opts.promptPath.replace(/'/g, "'\\''");
  const perm = config.permissionFlag ? ` ${config.permissionFlag}` : "";

  switch (config.promptMode) {
    case "file":
      return `${config.binary}${perm} --model ${model} --prompt-file '${escaped}'`;
    case "stdin":
      return `${config.binary}${perm} --model ${model} < '${escaped}'`;
  }
}
