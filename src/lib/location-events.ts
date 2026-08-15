import type { FeedEvent, FeedEventType } from "./feed";

/**
 * Location lifecycle events — a timekeeper-owned, single-writer event stream.
 *
 * Part of the fleet event-sourcing model (2026-06-28 roundtable consensus):
 *   - LOG   = this append-only event stream (git single-writer, immutable floor)
 *   - STATE = a projection/fold over the stream (current_location + dwell),
 *             materialised into the read index — never stored as mutable truth.
 *
 * `LocationEnter`/`LocationExit` move the projection (state transitions).
 * `LocationStillHere` is liveness-only: it refreshes "last verified" without
 * moving state, so staleness = `now − head_event_ts > k × expected_interval`.
 *
 * Mirrors the shape/conventions of ./message-events.ts.
 */

export type LocationTransition = "enter" | "exit" | "still";
export type LocationSource = "findmy" | "gps" | "wifi" | "manual" | string;

export interface LocationLifecycleData {
  /** Event id — the offset anchor a verdict's source-hash binds to (new event past
   *  it ⇒ projection re-folds ⇒ any cached verdict auto-invalidates). */
  id: string;
  ts: string;
  transition: LocationTransition;
  /** Canonical known-location short id, e.g. "home", "bkk", "cnx". */
  locationId: string;
  /** Human-readable place label, e.g. "Home (Doi Saket)". */
  placeName: string;
  lat?: number;
  lon?: number;
  source: LocationSource;
  /** 0..1 confidence in the fix. */
  confidence?: number;
  /** Device that produced the fix, e.g. "Nat iPhone12mini". */
  device: string;
  /** Previous event id — chains the stream for fast fold + gap detection (a missing
   *  link ⇒ a dropped event ⇒ repair by git-pull + re-project). */
  prevEventId?: string;
  /** Derived cache, never authority: dwell is always recomputed from Enter/Exit ts.
   *  Logged only for convenience; readers must not trust this value. */
  dwellMs?: number;
}

export type LocationLifecycleInput = Omit<LocationLifecycleData, "id" | "ts"> & {
  id?: string;
  ts?: string | number | Date;
};

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isoTs(ts: LocationLifecycleInput["ts"]): string {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string" && ts.trim()) {
    // Normalize rather than passing through: guarantee data.ts is always real ISO.
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** Single source of truth: the FeedEventType is derived from `transition`, so the
 *  two can never disagree. */
function eventTypeFor(transition: LocationTransition): FeedEventType {
  if (transition === "exit") return "LocationExit";
  if (transition === "still") return "LocationStillHere";
  return "LocationEnter";
}

export function buildLocationLifecycleData(input: LocationLifecycleInput): LocationLifecycleData {
  return {
    id: input.id ?? randomId(),
    ts: isoTs(input.ts),
    transition: input.transition,
    locationId: input.locationId,
    placeName: input.placeName,
    ...(input.lat !== undefined ? { lat: input.lat } : {}),
    ...(input.lon !== undefined ? { lon: input.lon } : {}),
    source: input.source,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    device: input.device,
    ...(input.prevEventId ? { prevEventId: input.prevEventId } : {}),
    ...(input.dwellMs !== undefined ? { dwellMs: input.dwellMs } : {}),
  };
}

export function buildLocationLifecycleFeedEvent(input: LocationLifecycleInput): FeedEvent {
  const data = buildLocationLifecycleData(input);
  const timestamp = data.ts;
  const ts = new Date(timestamp).getTime() || Date.now();
  const message = [
    data.transition,
    data.placeName,
    data.dwellMs !== undefined ? `dwell=${Math.round(data.dwellMs / 1000)}s` : "",
    data.confidence !== undefined ? `conf=${data.confidence}` : "",
  ].filter(Boolean).join(" ");

  return {
    timestamp,
    oracle: "timekeeper",
    // Physical location is body-centric, not host-bound; provenance is the
    // single-writer `oracle` stamp. Left blank intentionally.
    host: "",
    event: eventTypeFor(data.transition),
    project: "",
    // Intentional reuse: no dedicated location slot on FeedEvent, so the
    // envelope carries locationId here (the full payload lives in `data`).
    sessionId: data.locationId,
    message,
    ts,
    data,
  };
}

export function isLocationLifecycleData(value: unknown): value is LocationLifecycleData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.ts === "string"
    && (v.transition === "enter" || v.transition === "exit" || v.transition === "still")
    && typeof v.locationId === "string"
    && typeof v.placeName === "string"
    && typeof v.source === "string"
    && typeof v.device === "string";
}
