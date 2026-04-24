/**
 * oracle-members.ts — persistent oracle member registry for teams (#627 Phase 1).
 *
 * Stores team membership in ~/.config/maw/teams/<team-name>/oracle-members.json.
 * Each member is a named oracle (budded from maw bud, or any oracle with a
 * CLAUDE.md + ψ/ vault) that persists across sessions. This is the "oracle-team"
 * paradigm: team members are not ephemeral agents — they have identity, memory,
 * and accumulated domain knowledge.
 *
 * Phase 1 scope:
 *   - maw team oracle-invite <oracle-name> [--team <team>] [--role <role>]
 *   - maw team members [--team <team>]
 *   - team:<team-name> fan-out routing via maw hey
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../../../core/paths";

// ─── Types ───

export interface OracleMember {
  /** Oracle name (e.g. "mawjs-plugin-oracle", "security-oracle") */
  oracle: string;
  /** Role within the team (e.g. "researcher", "builder", "reviewer") */
  role: string;
  /** ISO timestamp when the oracle was added */
  addedAt: string;
}

export interface OracleTeamRegistry {
  /** Team name */
  name: string;
  /** Persistent oracle members */
  members: OracleMember[];
  /** ISO timestamp when registry was created */
  createdAt: string;
}

// ─── Paths ───

function teamRegistryDir(teamName: string): string {
  return join(CONFIG_DIR, "teams", teamName);
}

function teamRegistryPath(teamName: string): string {
  return join(teamRegistryDir(teamName), "oracle-members.json");
}

// ─── Registry CRUD ───

export function loadOracleRegistry(teamName: string): OracleTeamRegistry | null {
  const path = teamRegistryPath(teamName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function ensureRegistry(teamName: string): OracleTeamRegistry {
  const existing = loadOracleRegistry(teamName);
  if (existing) return existing;
  const registry: OracleTeamRegistry = {
    name: teamName,
    members: [],
    createdAt: new Date().toISOString(),
  };
  const dir = teamRegistryDir(teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(teamRegistryPath(teamName), JSON.stringify(registry, null, 2));
  return registry;
}

function saveRegistry(teamName: string, registry: OracleTeamRegistry): void {
  const dir = teamRegistryDir(teamName);
  mkdirSync(dir, { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: registry under ~/.config/maw/teams/, see docs/security/file-system-race-stance.md
  writeFileSync(teamRegistryPath(teamName), JSON.stringify(registry, null, 2));
}

// ─── Commands ───

/**
 * Add an oracle as a persistent member of a team.
 * Idempotent — re-inviting updates the role.
 */
export function cmdOracleInvite(
  teamName: string,
  oracleName: string,
  opts: { role?: string } = {},
): void {
  const registry = ensureRegistry(teamName);
  const role = opts.role || "member";
  const existing = registry.members.findIndex(m => m.oracle === oracleName);

  const entry: OracleMember = {
    oracle: oracleName,
    role,
    addedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    registry.members[existing] = entry;
    console.log(`\x1b[32m✓\x1b[0m updated '${oracleName}' in team '${teamName}' (role: ${role})`);
  } else {
    registry.members.push(entry);
    console.log(`\x1b[32m✓\x1b[0m added '${oracleName}' to team '${teamName}' (role: ${role})`);
  }

  saveRegistry(teamName, registry);
  console.log(`  \x1b[90m${teamRegistryPath(teamName)}\x1b[0m`);
}

/**
 * Remove an oracle from a team.
 */
export function cmdOracleRemove(teamName: string, oracleName: string): void {
  const registry = loadOracleRegistry(teamName);
  if (!registry) {
    console.log(`\x1b[33m⚠\x1b[0m team '${teamName}' has no oracle member registry`);
    return;
  }

  const idx = registry.members.findIndex(m => m.oracle === oracleName);
  if (idx < 0) {
    console.log(`\x1b[33m⚠\x1b[0m '${oracleName}' is not a member of team '${teamName}'`);
    return;
  }

  registry.members.splice(idx, 1);
  saveRegistry(teamName, registry);
  console.log(`\x1b[32m✓\x1b[0m removed '${oracleName}' from team '${teamName}'`);
}

/**
 * List persistent oracle members of a team.
 */
export function cmdOracleMembers(teamName: string): OracleMember[] {
  const registry = loadOracleRegistry(teamName);
  if (!registry || registry.members.length === 0) {
    console.log(`\x1b[90mNo oracle members in team '${teamName}'.\x1b[0m`);
    console.log(`\x1b[90m  add one: maw team oracle-invite <oracle-name> --team ${teamName}\x1b[0m`);
    return [];
  }

  console.log();
  console.log(`  \x1b[36;1mOracle members of '${teamName}'\x1b[0m (${registry.members.length})`);
  console.log();

  for (const m of registry.members) {
    const added = new Date(m.addedAt).toLocaleDateString();
    console.log(`  \x1b[32m●\x1b[0m ${m.oracle.padEnd(30)} \x1b[90mrole:\x1b[0m ${m.role.padEnd(15)} \x1b[90madded:\x1b[0m ${added}`);
  }
  console.log();

  return registry.members;
}

/**
 * Get all oracle member names for a team (for routing fan-out).
 */
export function getOracleMembers(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  if (!registry) return [];
  return registry.members.map(m => m.oracle);
}
