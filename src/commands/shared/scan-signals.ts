import { join } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import type { Signal } from "../../core/fleet/leaf";

interface ScanOptions {
  days?: number;
}

export interface ScannedSignal extends Signal {
  file: string;
}

/**
 * Read ψ/memory/signals/ under `root`, filter to the last `days` days (default 7).
 * Returns signals sorted newest-first.
 */
export function scanSignals(root: string, opts: ScanOptions = {}): ScannedSignal[] {
  const days = opts.days ?? 7;
  const dir = join(root, "ψ", "memory", "signals");
  if (!existsSync(dir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const results: ScannedSignal[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const signal = JSON.parse(raw) as Signal;
      if (new Date(signal.timestamp) >= cutoff) {
        results.push({ ...signal, file });
      }
    } catch {
      // skip malformed files
    }
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
