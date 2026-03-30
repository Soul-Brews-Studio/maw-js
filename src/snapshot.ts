/**
 * Fleet Time Machine — snapshot and restore tmux session state.
 *
 * Snapshots are taken automatically on every transaction:
 *   maw wake  → snapshot after wake
 *   maw sleep → snapshot after sleep
 *   maw done  → snapshot after done
 *
 * Stored as timestamped JSON files:
 *   ~/.config/maw/snapshots/2026-03-30T11-19.json
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
import { CONFIG_DIR } from "./paths";
import { listSessions } from "./ssh";
import { loadConfig } from "./config";

export const SNAPSHOT_DIR = join(CONFIG_DIR, "snapshots");
mkdirSync(SNAPSHOT_DIR, { recursive: true });

const MAX_SNAPSHOTS = 48;

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
    node: config.node || "local",
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
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const filename = `${ts}.json`;
  const filepath = join(SNAPSHOT_DIR, filename);

  writeFileSync(filepath, JSON.stringify(snapshot, null, 2) + "\n");

  // Prune old snapshots
  pruneSnapshots();

  return filepath;
}

/** List all snapshots, newest first */
export function listSnapshots(): { file: string; timestamp: string; trigger: string; sessionCount: number; windowCount: number }[] {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse();

  return files.map(f => {
    try {
      const data: Snapshot = JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), "utf-8"));
      const windowCount = data.sessions.reduce((sum, s) => sum + s.windows.length, 0);
      return {
        file: f,
        timestamp: data.timestamp,
        trigger: data.trigger,
        sessionCount: data.sessions.length,
        windowCount,
      };
    } catch {
      return { file: f, timestamp: "?", trigger: "?", sessionCount: 0, windowCount: 0 };
    }
  });
}

/** Load a specific snapshot */
export function loadSnapshot(fileOrTimestamp: string): Snapshot | null {
  // Accept full filename or partial timestamp
  const files = readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith(".json")).sort().reverse();

  const match = files.find(f =>
    f === fileOrTimestamp ||
    f === `${fileOrTimestamp}.json` ||
    f.startsWith(fileOrTimestamp)
  );

  if (!match) return null;

  try {
    return JSON.parse(readFileSync(join(SNAPSHOT_DIR, match), "utf-8"));
  } catch {
    return null;
  }
}

/** Get the latest snapshot */
export function latestSnapshot(): Snapshot | null {
  const files = readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(SNAPSHOT_DIR, files[0]), "utf-8"));
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
