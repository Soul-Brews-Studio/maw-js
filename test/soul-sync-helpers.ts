import { existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Pure sync logic — no ssh/tmux. Same algorithm as soul-sync.ts syncDir.
 */
export function syncDirForTest(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) return 0;
  let count = 0;

  function walk(src: string, dst: string) {
    let entries: string[];
    try { entries = readdirSync(src, { withFileTypes: true } as any) as any; }
    catch { return; }

    for (const entry of entries as any[]) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (!existsSync(dstPath)) {
        try {
          mkdirSync(dst, { recursive: true });
          copyFileSync(srcPath, dstPath);
          count++;
        } catch { /* skip */ }
      }
    }
  }

  walk(srcDir, dstDir);
  return count;
}

interface FleetEntry {
  name: string;
  windows: { name: string; repo: string }[];
  sync_peers?: string[];
  project_repos?: string[];
  skip_command?: boolean;
}

/**
 * Pure logic — findProjectsForOracle without loadFleet() dependency.
 */
export function findProjectsForOracleForTest(oracleName: string, fleet: FleetEntry[]): string[] {
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName) return sess.project_repos || [];
  }
  return [];
}

/**
 * Pure logic — findOracleForProject without loadFleet() dependency.
 */
export function findOracleForProjectForTest(projectRepo: string, fleet: FleetEntry[]): string | null {
  for (const sess of fleet) {
    if (sess.project_repos?.includes(projectRepo)) {
      return sess.name.replace(/^\d+-/, "");
    }
  }
  return null;
}

/**
 * Pure logic — findPeers without loadFleet() dependency.
 */
export function findPeersForTest(oracleName: string, fleet: FleetEntry[]): string[] {
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName && sess.sync_peers) return sess.sync_peers;
  }
  return [];
}
