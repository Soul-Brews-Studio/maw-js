import { listSessions, type OracleEntry } from "../../../sdk";
import { ghqFind, ghqList } from "../../../core/ghq";
import { UserError } from "../../../core/util/user-error";
import { loadFleetEntries } from "../../shared/fleet-load";

/** Like resolveOracle but returns null instead of throwing on miss */
export async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  if (oracle.includes("/")) {
    const repoPath = await ghqFind(`/${oracle}$`).catch(() => null);
    if (!repoPath) return { parentDir: "", repoName: "", repoPath: "" };
    return parseRepoPath(repoPath);
  }

  const repos = await ghqList().catch(() => [] as string[]);
  const wantedOracle = `${oracle}-oracle`.toLowerCase();
  const directName = oracle.toLowerCase();

  const oracleCandidates = repoCandidatesByBasename(repos, wantedOracle);
  if (oracleCandidates.length > 1) {
    throw ambiguousOracleError(oracle, oracleCandidates);
  }
  if (oracleCandidates.length === 1) return parseRepoPath(oracleCandidates[0]!);

  const directCandidates = repoCandidatesByBasename(repos, directName);
  if (directCandidates.length > 1) {
    throw ambiguousOracleError(oracle, directCandidates);
  }
  if (directCandidates.length === 1) return parseRepoPath(directCandidates[0]!);

  return { parentDir: "", repoName: "", repoPath: "" };
}

function repoCandidatesByBasename(repos: string[], basename: string): string[] {
  const seen = new Map<string, string>();
  for (const repoPath of repos) {
    if (repoPath.split("/").pop()?.toLowerCase() !== basename) continue;
    if (isArchiveLikePath(repoPath)) continue;
    const key = canonicalRepoKey(repoPath);
    if (!seen.has(key)) seen.set(key, repoPath);
  }
  return [...seen.values()];
}

function isArchiveLikePath(repoPath: string): boolean {
  const archiveSegments = new Set([
    "_archive",
    ".archive",
    "archive",
    "archives",
    "backup",
    "backups",
    "snapshot",
    "snapshots",
  ]);
  return repoPath
    .split("/")
    .some((segment) => archiveSegments.has(segment.toLowerCase()));
}

function canonicalRepoKey(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, "/").toLowerCase();
  const marker = "/github.com/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  return normalized;
}

function ambiguousOracleError(oracle: string, candidates: string[]): UserError {
  return new UserError(`ambiguous oracle short-name '${oracle}' (${candidates.length} matches): ${candidates.join(", ")}`);
}

function parseRepoPath(repoPath: string): { repoPath: string; repoName: string; parentDir: string } {
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

/** Discover oracles: union of fleet configs + running tmux sessions */
export async function discoverOracles(): Promise<string[]> {
  const names = new Set<string>();

  // 1. Fleet configs (registered — includes sleeping)
  try {
    for (const entry of loadFleetEntries()) {
      for (const w of entry.session?.windows || []) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* fleet dirs may not exist or may contain bad JSON */ }

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
