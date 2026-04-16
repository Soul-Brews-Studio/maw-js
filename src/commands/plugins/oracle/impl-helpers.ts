import { listSessions, FLEET_DIR, type OracleEntry } from "../../../sdk";
import { ghqFind } from "../../../core/ghq";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Like resolveOracle but returns null instead of throwing on miss */
export async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  // Try oracle-oracle pattern first, then direct name (e.g., homekeeper → homelab)
  const repoPath = (await ghqFind(`/${oracle}-oracle$`)) ?? (await ghqFind(`/${oracle}$`));
  if (!repoPath) return { parentDir: "", repoName: "", repoPath: "" };
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

/** Discover oracles: union of fleet configs + running tmux sessions */
export async function discoverOracles(): Promise<string[]> {
  const names = new Set<string>();

  // 1. Fleet configs (registered — includes sleeping)
  const fleetDir = FLEET_DIR;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      for (const w of config.windows || []) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* fleet dir may not exist */ }

  // 2. Running tmux (actual state — catches unregistered oracles)
  try {
    const sessions = await listSessions();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* tmux not running */ }

  return [...names].sort();
}

export interface OracleStatus {
  name: string;
  session: string | null;
  windows: string[];
  worktrees: number;
  status: "awake" | "sleeping";
}

/**
 * Source-lineage for an oracle entry — "why is this in the list?"
 * Drives the icon column in the grouped `ls` view.
 */
export interface OracleLineage {
  hasFleetConfig: boolean;   // ~/.config/maw/fleet/<name>.json exists
  hasPsi: boolean;           // <repo>/ψ exists
  isAwake: boolean;          // tmux session running
  inAgents: boolean;         // appears in config.agents
  federationNode?: string;   // from config.agents (or entry's federation_node)
}

export function lineageOf(
  entry: OracleEntry,
  awake: boolean,
  agents: Record<string, string>,
): OracleLineage {
  return {
    hasFleetConfig: entry.has_fleet_config,
    hasPsi: entry.has_psi,
    isAwake: awake,
    inAgents: entry.name in agents,
    federationNode: agents[entry.name] ?? entry.federation_node ?? undefined,
  };
}

export function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
