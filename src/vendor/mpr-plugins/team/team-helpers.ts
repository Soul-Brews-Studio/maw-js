import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// Exported for testing — override with _setDirs
export let TEAMS_DIR = join(homedir(), ".claude/teams");
export let TASKS_DIR = join(homedir(), ".claude/tasks");

/** @internal — for tests only */
export function _setDirs(teams: string, tasks: string) {
  TEAMS_DIR = teams;
  TASKS_DIR = tasks;
}

export interface TeamMember {
  name: string;
  role?: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
  color?: string;
  model?: string;
  backendType?: string;
}

export interface TeamConfig {
  name: string;
  description?: string;
  members: TeamMember[];
  createdAt?: number;
  leadSessionId?: string;
  leadClaimedAt?: number;
}

export interface TeamLeadClaim {
  found: boolean;
  claimed: boolean;
  oldLeadSessionId?: string;
  newLeadSessionId?: string;
  teammates: string[];
}

export function loadTeam(name: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, name, "config.json");
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { return null; }
}

export function currentLeadSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_SESSION_ID
    || env.CODEX_THREAD_ID
    || env.OMX_SESSION_ID
    || env.ATUIN_SESSION
    || undefined;
}

export function teamTeammateNames(team: TeamConfig): string[] {
  return (team.members || [])
    .filter(m => m.agentType !== "team-lead" && m.role !== "lead" && m.name !== "team-lead")
    .map(m => m.name)
    .filter(Boolean);
}

export function isTeamLeadOrphaned(team: TeamConfig, currentSessionId = currentLeadSessionId()): boolean {
  return Boolean(team.leadSessionId && currentSessionId && team.leadSessionId !== currentSessionId);
}

export function claimOrphanedTeamLead(name: string, currentSessionId = currentLeadSessionId()): TeamLeadClaim {
  const configPath = join(TEAMS_DIR, name, "config.json");
  if (!existsSync(configPath)) return { found: false, claimed: false, teammates: [] };
  const team = loadTeam(name);
  if (!team) return { found: false, claimed: false, teammates: [] };

  const oldLeadSessionId = team.leadSessionId;
  const teammates = teamTeammateNames(team);
  if (!oldLeadSessionId || !currentSessionId || oldLeadSessionId === currentSessionId) {
    return { found: true, claimed: false, oldLeadSessionId, newLeadSessionId: currentSessionId, teammates };
  }

  const updated: TeamConfig = {
    ...team,
    leadSessionId: currentSessionId,
    leadClaimedAt: Date.now(),
  };
  writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return {
    found: true,
    claimed: true,
    oldLeadSessionId,
    newLeadSessionId: currentSessionId,
    teammates,
  };
}

/**
 * Resolve ψ/ directory by walking UP from cwd looking for an oracle root
 * (marked by CLAUDE.md + ψ/). Falls back to cwd/ψ for backward compat when
 * no marker is found. Prevents rogue nested vaults when the CLI is run from
 * a sub-directory (#393 — Bug A).
 */
export function resolvePsi(): string {
  let dir = process.cwd();
  // Walk up looking for an oracle root (CLAUDE.md + ψ/ both present)
  while (true) {
    const psi = join(dir, "ψ");
    if (existsSync(psi) && existsSync(join(dir, "CLAUDE.md"))) return psi;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: legacy behavior — cwd/ψ, callers mkdir as needed
  return join(process.cwd(), "ψ");
}

/**
 * Write a shutdown_request message to a teammate's inbox file.
 * This is the same protocol Claude Code uses internally via SendMessage.
 */
export function writeShutdownRequest(teamName: string, memberName: string, reason: string): void {
  const inboxPath = join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
  let messages: any[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  const requestId = `shutdown-${Date.now()}@${memberName}`;
  messages.push({
    from: "maw-team-shutdown",
    text: JSON.stringify({ type: "shutdown_request", reason, request_id: requestId }),
    summary: `Shutdown request: ${reason}`,
    timestamp: new Date().toISOString(),
    read: false,
  });
  // lgtm[js/file-system-race] — PRIVATE-PATH: inbox under ~/.maw/teams/<team>/inboxes/, see docs/security/file-system-race-stance.md
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

/**
 * Write a generic message to a teammate's inbox file.
 * Same protocol as writeShutdownRequest but with type: "message".
 */
export function writeMessage(teamName: string, memberName: string, from: string, text: string): void {
  const inboxPath = join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
  let messages: any[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  messages.push({
    from,
    text: JSON.stringify({ type: "message", content: text }),
    summary: text.slice(0, 80),
    timestamp: new Date().toISOString(),
    read: false,
  });
  mkdirSync(join(TEAMS_DIR, teamName, "inboxes"), { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: inbox under ~/.maw/teams/<team>/inboxes/, see docs/security/file-system-race-stance.md
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

export function cleanupTeamDir(name: string) {
  const teamDir = join(TEAMS_DIR, name);
  const tasksDir = join(TASKS_DIR, name);
  if (existsSync(teamDir)) { try { rmSync(teamDir, { recursive: true }); } catch {} }
  if (existsSync(tasksDir)) { try { rmSync(tasksDir, { recursive: true }); } catch {} }
}
