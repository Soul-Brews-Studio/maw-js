import { readFileSync, renameSync, writeFileSync } from "fs";
import { loadConfig } from "maw-js/config";

export interface RetentionPolicy {
  keepLast?: number;
  maxAgeDays?: number;
  now?: Date;
}

export interface RetentionResolvedPolicy {
  keepLast: number;
  maxAgeDays: number;
}

export interface JsonlRetentionSummary {
  retained: number;
  removed: number;
  policy: RetentionResolvedPolicy;
}

const DEFAULT_KEEP_LAST = 10_000;
const DEFAULT_MAX_AGE_DAYS = 14;

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveMessageRetentionPolicy(policy: RetentionPolicy = {}): RetentionResolvedPolicy {
  const config = (() => {
    try { return loadConfig().messageRetention || {}; } catch { return {}; }
  })();
  const keepLast = positiveInt(policy.keepLast)
    ?? positiveInt(process.env.MAW_MESSAGE_KEEP_LAST)
    ?? positiveInt((config as any).keepLast)
    ?? DEFAULT_KEEP_LAST;
  const maxAgeDays = positiveInt(policy.maxAgeDays)
    ?? positiveInt(process.env.MAW_MESSAGE_MAX_AGE_DAYS)
    ?? positiveInt((config as any).maxAgeDays)
    ?? DEFAULT_MAX_AGE_DAYS;
  return { keepLast, maxAgeDays };
}

function lineTimeMs(line: string): number {
  try {
    const parsed = JSON.parse(line);
    const ts = parsed?.ts || parsed?.timestamp;
    const time = typeof ts === "number" ? ts : Date.parse(String(ts || ""));
    return Number.isFinite(time) ? time : 0;
  } catch {
    return 0;
  }
}

export function pruneJsonlFile(path: string, policy: RetentionPolicy = {}): JsonlRetentionSummary {
  const resolved = resolveMessageRetentionPolicy(policy);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  } catch {
    return { retained: 0, removed: 0, policy: resolved };
  }

  const nowMs = (policy.now ?? new Date()).getTime();
  const maxAgeMs = resolved.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Math.max(0, lines.length - resolved.keepLast);
  const retained = lines.filter((line, index) => {
    if (index >= cutoff) return true;
    const timeMs = lineTimeMs(line);
    return !timeMs || nowMs - timeMs <= maxAgeMs;
  });
  const removed = lines.length - retained.length;
  if (removed > 0) {
    const tmp = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, retained.length ? `${retained.join("\n")}\n` : "", "utf-8");
    renameSync(tmp, path);
  }
  return { retained: retained.length, removed, policy: resolved };
}
