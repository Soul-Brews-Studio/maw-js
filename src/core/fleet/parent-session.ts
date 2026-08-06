import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, join } from "path";

export interface ResolveParentSessionIdInput {
  explicit?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnSessionEnvInput extends ResolveParentSessionIdInput {
  sessionId?: string;
}

function cleanSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function encodeClaudeProjectPath(path: string): string {
  const absolute = toPosixPath(resolve(path));
  const withDriveMarker = absolute.replace(/^([A-Za-z]):\//, "/$1--");
  return withDriveMarker.replace(/^\//, "-").replace(/\//g, "-");
}

function claudeProjectDirForCwd(cwd: string, env: NodeJS.ProcessEnv): string {
  const projectsRoot = env.MAW_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
  return join(projectsRoot, encodeClaudeProjectPath(cwd));
}

function newestClaudeJsonlSessionId(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const dir = claudeProjectDirForCwd(cwd, env);
  let newest: { id: string; mtimeMs: number } | undefined;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl") || entry.includes("subagents")) continue;
      const path = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(path); } catch { continue; }
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { id: entry.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs };
      }
    }
  } catch {
    return undefined;
  }
  return newest?.id;
}

export function resolveParentSessionId(input: ResolveParentSessionIdInput = {}): string | undefined {
  const env = input.env ?? process.env;
  return cleanSessionId(input.explicit)
    || cleanSessionId(env.MAW_PARENT_SESSION_ID)
    || cleanSessionId(env.CLAUDE_SESSION_ID)
    || newestClaudeJsonlSessionId(input.cwd ?? process.cwd(), env);
}

export function spawnSessionEnv(input: SpawnSessionEnvInput = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const parent = resolveParentSessionId(input);
  const sessionId = cleanSessionId(input.sessionId);
  if (parent) env.MAW_PARENT_SESSION_ID = parent;
  if (sessionId) env.MAW_SESSION_ID = sessionId;
  return env;
}

export function shellQuoteEnv(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function prefixCommandWithSpawnSessionEnv(
  command: string,
  input: SpawnSessionEnvInput = {},
): string {
  const env = spawnSessionEnv(input);
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuoteEnv(value)}`).join(" ");
  return prefix ? `${prefix} ${command}` : command;
}

export function hasClaudeSessionForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(claudeProjectDirForCwd(cwd, env));
}
