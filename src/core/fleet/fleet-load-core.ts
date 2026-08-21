import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fleetDirForWrite as coreFleetDirForWrite, fleetDirsForRead as coreFleetDirsForRead, uniqueDirs } from "./paths";

export interface FleetWindow {
  name: string;
  repo: string;
  /** Recoverable runtime identity captured for this window (#dept-roster D-5).
   *  Present only for windows whose session was captured for resume; absent
   *  windows fall through to a normal fresh wake. */
  runtime?: FleetRuntimeIdentity;
}

/** A window's captured engine session, enough to resume it after a reboot. */
export interface FleetRuntimeIdentity {
  engine: string;
  cwd: string;
  nativeSessionId: string;
  capturedAt: string;
  /** Optional persistent launch binding: what recovery must restore beyond a
   *  bare `cd <cwd> && <engine> resume` — a ratified workRoot and a dedicated
   *  env (e.g. CODEX_HOME). Absent on legacy captures; recovery then behaves
   *  exactly as before. */
  launch?: FleetRuntimeLaunchBinding;
}

export interface FleetRuntimeLaunchBinding {
  /** Ratified workRoot to recover into; overrides the captured cwd. */
  cwd?: string;
  /** Env exported ahead of the resume command (e.g. CODEX_HOME). */
  env?: Record<string, string>;
  /** Canonical fresh-launch argv for wake paths that start a new process
   *  instead of resuming; stored for those consumers. */
  argv?: string[];
}

export interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
  /** Peer oracle names for soul-sync (flat, no hierarchy). */
  sync_peers?: string[];
  /** Optional parent oracle/fleet name for bud lineage. */
  budded_from?: string;
  /** Project repos (org/repo) this oracle absorbs ψ/ from via `maw soul-sync --project`. */
  project_repos?: string[];
}

export interface FleetEntry {
  file: string;
  /** Absolute path of the config file that supplied this entry. */
  path?: string;
  num: number;
  groupName: string;
  session: FleetSession;
}

export interface DisabledFleetEntry {
  file: string;
  /** Absolute path of the disabled config file that supplied this entry. */
  path: string;
  num: number;
  groupName: string;
  session?: FleetSession;
  error?: unknown;
}

export function fleetDirsForRead(legacyFleetDir?: string): string[] {
  return legacyFleetDir ? coreFleetDirsForRead({ legacyFleetDir }) : uniqueDirs([coreFleetDirForWrite()]);
}

export function fleetDirForWrite(): string {
  return coreFleetDirForWrite();
}

function readFleetFiles(dirs: string[]): Array<{ file: string; path: string; session: FleetSession }> {
  const byName = new Map<string, { file: string; path: string; session: FleetSession }>();
  for (const dir of uniqueDirs(dirs)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
        .sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (byName.has(file)) continue;
      const path = join(dir, file);
      try {
        byName.set(file, { file, path, session: JSON.parse(readFileSync(path, "utf-8")) as FleetSession });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid fleet JSON ${path}: ${message}`);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function readDisabledFleetFiles(dirs: string[]): Array<{ file: string; path: string }> {
  const byName = new Map<string, { file: string; path: string }>();
  for (const dir of uniqueDirs(dirs)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter(f => f.endsWith(".disabled"))
        .sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!byName.has(file)) byName.set(file, { file, path: join(dir, file) });
    }
  }
  return [...byName.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function parseFleetFileInfo(file: string): { num: number; groupName: string } {
  const activeName = file.replace(/\.disabled$/i, "");
  const match = activeName.match(/^(\d+)-(.+)\.json$/);
  return {
    num: match ? parseInt(match[1], 10) : 0,
    groupName: match ? match[2] : activeName.replace(/\.json$/i, ""),
  };
}

export function loadFleet(dirs: string[] = fleetDirsForRead()): FleetSession[] {
  return readFleetFiles(dirs).map(({ session }) => session);
}

export function countDisabledFleetFiles(dirs: string[] = fleetDirsForRead()): number {
  return readDisabledFleetFiles(dirs).length;
}

export function loadDisabledFleetEntries(dirs: string[] = fleetDirsForRead()): DisabledFleetEntry[] {
  return readDisabledFleetFiles(dirs).map(({ file, path }) => {
    const { num, groupName } = parseFleetFileInfo(file);
    try {
      return { file, path, num, groupName, session: JSON.parse(readFileSync(path, "utf-8")) as FleetSession };
    } catch (error) {
      return { file, path, num, groupName, error };
    }
  });
}

export function loadFleetEntries(dirs: string[] = fleetDirsForRead()): FleetEntry[] {
  return readFleetFiles(dirs).map(({ file, path, session }) => {
    const { num, groupName } = parseFleetFileInfo(file);
    return { file, path, num, groupName, session };
  });
}
