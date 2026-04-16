import { listSessions, hostExec, FLEET_DIR } from "../../../sdk";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Like resolveOracle but returns null instead of process.exit */
export async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  try {
    // Try oracle-oracle pattern first
    let ghqOut = await hostExec(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`).catch(() => "");
    if (!ghqOut.trim()) {
      // Try direct name (e.g., homekeeper → homelab)
      ghqOut = await hostExec(`ghq list --full-path | grep -i '/${oracle}$' | head -1`).catch(() => "");
    }
    if (!ghqOut.trim()) return { parentDir: "", repoName: "", repoPath: "" };
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  } catch {
    return { parentDir: "", repoName: "", repoPath: "" };
  }
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
