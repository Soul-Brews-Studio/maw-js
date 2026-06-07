/**
 * Fleet Time Machine — snapshot and restore tmux session state.
 *
 * Snapshots are taken automatically on every transaction:
 *   maw wake  → snapshot after wake
 *   maw sleep → snapshot after sleep
 *   maw done  → snapshot after done
 *
 * Stored as timestamped JSON files:
 *   ~/.maw/snapshots/2026-03-30T11-19.json
 *   or, with MAW_XDG=1, ~/.local/state/maw/snapshots/...
 *
 * CLI:
 *   maw fleet snapshots          — list all snapshots
 *   maw fleet restore            — show latest snapshot
 *   maw fleet restore <timestamp> — show specific snapshot
 *
 * Keeps last 48 snapshots (prunes oldest on write).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { mawConfigPath, mawStatePath } from "../xdg";
import { listSessions } from "../transport/ssh";
import { loadConfig } from "../../config";

export function snapshotDir(): string {
  return mawStatePath("snapshots");
}

function legacySnapshotDir(): string {
  return mawConfigPath("snapshots");
}

function candidateSnapshotDirs(): string[] {
  const primary = snapshotDir();
  const legacy = legacySnapshotDir();
  return primary === legacy ? [primary] : [primary, legacy];
}

export const SNAPSHOT_DIR = snapshotDir();
mkdirSync(SNAPSHOT_DIR, { recursive: true });

const MAX_SNAPSHOTS = 720; // ~1 month at 1 snapshot/hour

export interface SnapshotWindow {
  name: string;
  paneCmd?: string;   // what's running (claude, zsh, etc.)
}

export interface SnapshotSession {
  name: string;
  windows: SnapshotWindow[];
}

export interface Snapshot {
  timestamp: string;       // ISO 8601
  trigger: string;         // "wake" | "sleep" | "done" | "auto" | "manual"
  node?: string;           // machine identity
  sessions: SnapshotSession[];
}

/** Take a snapshot of all current tmux sessions */
export async function takeSnapshot(trigger: string): Promise<string> {
  const sessions = await listSessions();

  const config = loadConfig();
  const snapshot: Snapshot = {
    timestamp: new Date().toISOString(),
    trigger,
    node: config.node ?? "local",
    sessions: sessions.map(s => ({
      name: s.name,
      windows: s.windows.map(w => ({
        name: w.name,
      })),
    })),
  };

  // Filename: YYYYMMDD-HHMM.json
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `${ts}.json`;
  const filepath = join(SNAPSHOT_DIR, filename);

  writeFileSync(filepath, JSON.stringify(snapshot, null, 2) + "\n");

  // Prune old snapshots
  pruneSnapshots();

  return filepath;
}

function snapshotFiles(): Array<{ dir: string; file: string }> {
  const byFile = new Map<string, { dir: string; file: string }>();
  for (const dir of candidateSnapshotDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, { dir, file });
    }
  }
  return [...byFile.values()].sort((a, b) => b.file.localeCompare(a.file));
}

/** List all snapshots, newest first */
export function listSnapshots(): { file: string; timestamp: string; trigger: string; sessionCount: number; windowCount: number }[] {
  return snapshotFiles().map(({ dir, file }) => {
    try {
      const data: Snapshot = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      const windowCount = data.sessions.reduce((sum, s) => sum + s.windows.length, 0);
      return {
        file,
        timestamp: data.timestamp,
        trigger: data.trigger,
        sessionCount: data.sessions.length,
        windowCount,
      };
    } catch {
      return { file, timestamp: "?", trigger: "?", sessionCount: 0, windowCount: 0 };
    }
  });
}

/** Load a specific snapshot */
export function loadSnapshot(fileOrTimestamp: string): Snapshot | null {
  // Accept full filename or partial timestamp
  const match = snapshotFiles().find(({ file }) =>
    file === fileOrTimestamp ||
    file === `${fileOrTimestamp}.json` ||
    file.startsWith(fileOrTimestamp)
  );

  if (!match) return null;

  try {
    return JSON.parse(readFileSync(join(match.dir, match.file), "utf-8"));
  } catch {
    return null;
  }
}

/** Get the latest snapshot */
export function latestSnapshot(): Snapshot | null {
  const latest = snapshotFiles()[0];
  if (!latest) return null;
  try {
    return JSON.parse(readFileSync(join(latest.dir, latest.file), "utf-8"));
  } catch {
    return null;
  }
}

/** Prune old snapshots, keep MAX_SNAPSHOTS newest */
function pruneSnapshots() {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  while (files.length > MAX_SNAPSHOTS) {
    const oldest = files.shift()!;
    try { unlinkSync(join(SNAPSHOT_DIR, oldest)); } catch {}
  }
}
