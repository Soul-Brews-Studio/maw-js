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
 * Applies retention on write: keep newest snapshots and prune old files.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
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

const DEFAULT_KEEP_LAST = 240;
const DEFAULT_MAX_AGE_DAYS = 14;

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

export interface SnapshotRetentionPolicy {
  keepLast?: number;
  maxAgeDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface SnapshotRetentionSummary {
  retained: number;
  removed: number;
  wouldRemove: number;
  policy: { keepLast: number; maxAgeDays: number };
  removedFiles: string[];
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveSnapshotRetentionPolicy(policy: SnapshotRetentionPolicy = {}): { keepLast: number; maxAgeDays: number } {
  const config = (() => {
    try { return loadConfig().snapshotRetention || {}; } catch { return {}; }
  })();
  const keepLast = positiveInt(policy.keepLast)
    ?? positiveInt(process.env.MAW_SNAPSHOT_KEEP_LAST)
    ?? positiveInt((config as any).keepLast)
    ?? DEFAULT_KEEP_LAST;
  const maxAgeDays = positiveInt(policy.maxAgeDays)
    ?? positiveInt(process.env.MAW_SNAPSHOT_MAX_AGE_DAYS)
    ?? positiveInt((config as any).maxAgeDays)
    ?? DEFAULT_MAX_AGE_DAYS;
  return { keepLast, maxAgeDays };
}

/** Take a snapshot of all current tmux sessions */
export async function takeSnapshot(trigger: string, retentionPolicy: SnapshotRetentionPolicy = {}): Promise<string> {
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
  pruneSnapshots(retentionPolicy);

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

function snapshotTimeMs(dir: string, file: string): number {
  try {
    const data: Snapshot = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    const parsed = Date.parse(data.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  } catch { /* fall back to filename/stat */ }

  const match = file.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, mo, d, h, mi, se] = match;
    const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }

  try { return statSync(join(dir, file)).mtimeMs; } catch { return 0; }
}

/** Prune snapshots by count and age. Defaults prevent unbounded growth (#2146). */
export function pruneSnapshots(policy: SnapshotRetentionPolicy = {}): SnapshotRetentionSummary {
  const resolved = resolveSnapshotRetentionPolicy(policy);
  const nowMs = (policy.now ?? new Date()).getTime();
  const maxAgeMs = resolved.maxAgeDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith(".json"))
    .map(file => ({ file, timeMs: snapshotTimeMs(SNAPSHOT_DIR, file) }))
    .sort((a, b) => b.timeMs - a.timeMs || b.file.localeCompare(a.file));

  const toRemove = files.filter((entry, index) => {
    if (index >= resolved.keepLast) return true;
    return Number.isFinite(entry.timeMs) && nowMs - entry.timeMs > maxAgeMs;
  });

  if (!policy.dryRun) {
    for (const { file } of toRemove) {
      try { unlinkSync(join(SNAPSHOT_DIR, file)); } catch {}
    }
  }

  return {
    retained: files.length - toRemove.length,
    removed: policy.dryRun ? 0 : toRemove.length,
    wouldRemove: policy.dryRun ? toRemove.length : 0,
    policy: resolved,
    removedFiles: toRemove.map(f => f.file),
  };
}
