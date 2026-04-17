import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

export type SignalKind = "info" | "alert" | "pattern";

export interface Signal {
  timestamp: string;
  bud: string;
  kind: SignalKind;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Drop a signal file into a parent oracle's ψ/memory/signals/ directory.
 * Returns the absolute path of the written file.
 *
 * Path: <parentRoot>/ψ/memory/signals/<YYYY-MM-DD>_<budName>_<slug>.json
 */
export function writeSignal(
  parentRoot: string,
  budName: string,
  payload: { kind: SignalKind; message: string; context?: Record<string, unknown> },
): string {
  const dir = join(parentRoot, "ψ", "memory", "signals");
  mkdirSync(dir, { recursive: true });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const slug = payload.message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || payload.kind;

  const signal: Signal = {
    timestamp: now.toISOString(),
    bud: budName,
    kind: payload.kind,
    message: payload.message,
    ...(payload.context ? { context: payload.context } : {}),
  };

  const filePath = join(dir, `${date}_${budName}_${slug}.json`);
  writeFileSync(filePath, JSON.stringify(signal, null, 2) + "\n");
  return filePath;
}
