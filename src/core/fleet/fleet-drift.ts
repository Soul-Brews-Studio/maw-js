import type { FleetSession } from "./fleet-load-core";

/**
 * Fleet-record drift classification.
 *
 * A fleet record's `windows[]` is written once at registration and is not
 * reconciled to live tmux windows by ordinary lifecycle ops (measured: MAW
 * fleet-hygiene lab, 2026-08-22). This helper classifies the drift between a
 * record and the live window set so hygiene tooling can detect (not repair) it.
 */
export type DriftClass =
  | "ok" // record windows == live windows
  | "no-record" // live session exists but has no fleet record (orphan / register skipped)
  | "record-missing-live" // live windows added after register, absent from the record
  | "record-has-dead"; // record lists windows no longer live (closed after register)

export interface DriftResult {
  session: string;
  drift: DriftClass;
  recordWindows: string[];
  liveWindows: string[];
  /** live windows absent from the record (added after registration) */
  unrecorded: string[];
  /** record windows absent from live (closed after registration / stale) */
  dead: string[];
}

/**
 * Classify the drift for one session.
 * @param record the loaded fleet record, or null/undefined if none exists
 * @param liveWindows the live tmux window names for the session
 */
export function classifyFleetDrift(
  session: string,
  record: FleetSession | null | undefined,
  liveWindows: string[],
): DriftResult {
  const recordWindows = record ? record.windows.map((w) => w.name) : [];
  const recSet = new Set(recordWindows);
  const liveSet = new Set(liveWindows);
  const unrecorded = liveWindows.filter((w) => !recSet.has(w));
  const dead = recordWindows.filter((w) => !liveSet.has(w));

  let drift: DriftClass;
  if (!record) {
    drift = "no-record";
  } else if (dead.length > 0) {
    // any stale record window => record-has-dead (also covers both-directions,
    // where a prune-then-add is needed; the dead windows are the safety concern)
    drift = "record-has-dead";
  } else if (unrecorded.length > 0) {
    drift = "record-missing-live";
  } else {
    drift = "ok";
  }

  return { session, drift, recordWindows, liveWindows, unrecorded, dead };
}

/** Convenience: true when a record perfectly matches live windows. */
export function isFleetRecordClean(
  record: FleetSession | null | undefined,
  liveWindows: string[],
): boolean {
  return classifyFleetDrift("", record, liveWindows).drift === "ok";
}
