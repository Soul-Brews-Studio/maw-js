import { execSync } from "child_process";
import { basename } from "path";

export interface IdentityResult {
  name: string;
  source: "env" | "cwd" | "tmux";
}

const ENV_KEYS = [
  "MAW_IDENTITY",
  "MAW_FROM",
  "MAW_AGENT_NAME",
  "ORACLE_NAME",
  "CLAUDE_AGENT_NAME",
  "AGENT_NAME",
] as const;

export function normalizeOracleName(value: string): string {
  return value
    .trim()
    .replace(/^\[[^\]:]+:/, "")
    .replace(/\]$/, "")
    .replace(/^.*:/, "")
    .replace(/^\d+-/, "")
    .replace(/-oracle$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();
}

function envIdentity(): IdentityResult | null {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    const name = normalizeOracleName(value);
    if (name) return { name, source: "env" };
  }
  return null;
}

function cwdIdentity(): IdentityResult | null {
  const cwd = process.cwd();
  const oraclePath = cwd.match(/\/oracles\/([^/]+)/);
  if (oraclePath?.[1]) {
    const name = normalizeOracleName(oraclePath[1]);
    if (name) return { name, source: "cwd" };
  }

  const repoName = basename(cwd);
  if (repoName.endsWith("-oracle")) {
    const name = normalizeOracleName(repoName);
    if (name) return { name, source: "cwd" };
  }

  return null;
}

function tmuxIdentity(): IdentityResult | null {
  if (!process.env.TMUX) return null;
  try {
    const session = execSync("tmux display-message -p '#{session_name}'", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const name = normalizeOracleName(session);
    if (name) return { name, source: "tmux" };
  } catch {
    // Outside tmux, callers must provide env or run from an oracle repo.
  }
  return null;
}

export function resolveOracleIdentity(): IdentityResult | null {
  return envIdentity() ?? cwdIdentity() ?? tmuxIdentity();
}

export function requireOracleIdentity(): IdentityResult {
  const identity = resolveOracleIdentity();
  if (identity) return identity;
  throw new Error(
    "maw cannot determine sender identity — set MAW_FROM, MAW_IDENTITY, MAW_AGENT_NAME, ORACLE_NAME, or CLAUDE_AGENT_NAME, or run from an oracle repo/tmux session",
  );
}
