/**
 * Pane-route registry (kobo-36 / eq3-036) — channel → pane mapping per oracle.
 *
 * `resolveOraclePane` (comm-send.ts) already honors an explicit `.N` suffix on a
 * target, else defaults to the oracle's lowest agent pane (`.0`, the main pane).
 * What was missing: the SENDER doesn't know which pane plays which ROLE inside a
 * multi-pane warroom. This registry closes that gap — an oracle declares e.g.
 * `task-events → .1` (its coordinator pane), and notify/hey delivery consults the
 * mapping to route board/task/federation events to the coord pane instead of the
 * default main pane.
 *
 * Storage: `mawStatePath("pane-routes.json")` — machine-local runtime state, NOT
 * git-synced. A tmux pane layout is inherently per-machine (a warroom on m5 has
 * nothing to do with one on a droplet), so this deliberately lives in the state
 * dir, not Company Home (which syncs across machines via git, ADR 0002).
 *
 * Shape: `{ "<oracle>": { "<channel>": <paneIndex> } }`. Oracle keys are the bare
 * name (node prefix + `-oracle` suffix stripped) so `local:eq3-oracle`, `eq3`, and
 * `mba:eq3` all resolve to the same registry entry.
 *
 * Backward-compat: no mapping registered → `getPaneRoute` returns null →
 * `resolveOraclePane` keeps its existing default-pane behavior unchanged.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mawStatePath } from "./xdg";

/** Well-known channel: board/task/federation events → coordinator pane. */
export const CHANNEL_TASK_EVENTS = "task-events";

export type PaneRouteMap = Record<string, Record<string, number>>;

function storePath(): string {
  return mawStatePath("pane-routes.json");
}

/**
 * Normalize any target/oracle spelling to the bare registry key:
 * strips a leading `<node>:` (or `<node>:<session>:`) prefix, a trailing
 * `.<pane>` suffix, and a `-oracle` suffix. Lowercased for case-insensitive
 * lookups (oracle names are conventionally lowercase).
 */
export function paneRouteOracleKey(oracle: string): string {
  const bare = oracle.split(":").at(-1) ?? oracle;
  return bare.replace(/\.[0-9]+$/, "").replace(/-oracle$/i, "").trim().toLowerCase();
}

export function loadPaneRoutes(): PaneRouteMap {
  try {
    const raw = readFileSync(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PaneRouteMap) : {};
  } catch {
    return {};
  }
}

function savePaneRoutes(map: PaneRouteMap): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n");
}

/**
 * Look up the pane index an oracle declared for a channel. Returns null when no
 * oracle/channel mapping exists — callers fall back to default pane resolution.
 */
export function getPaneRoute(oracle: string, channel: string): number | null {
  const key = paneRouteOracleKey(oracle);
  const idx = loadPaneRoutes()[key]?.[channel];
  return Number.isInteger(idx) ? (idx as number) : null;
}

/** Declare `channel → paneIndex` for an oracle. Idempotent (overwrites). */
export function setPaneRoute(oracle: string, channel: string, paneIndex: number): void {
  if (!Number.isInteger(paneIndex) || paneIndex < 0) {
    throw new Error(`invalid pane index '${paneIndex}' (expected a non-negative integer)`);
  }
  const key = paneRouteOracleKey(oracle);
  const map = loadPaneRoutes();
  (map[key] ??= {})[channel] = paneIndex;
  savePaneRoutes(map);
}

/** Remove a single channel mapping (or the whole oracle entry when channel omitted). */
export function removePaneRoute(oracle: string, channel?: string): boolean {
  const key = paneRouteOracleKey(oracle);
  const map = loadPaneRoutes();
  if (!map[key]) return false;
  if (!channel) {
    delete map[key];
    savePaneRoutes(map);
    return true;
  }
  if (!(channel in map[key])) return false;
  delete map[key][channel];
  if (Object.keys(map[key]).length === 0) delete map[key];
  savePaneRoutes(map);
  return true;
}

/** List mappings for one oracle (or the full registry when oracle omitted). */
export function listPaneRoutes(oracle?: string): PaneRouteMap {
  const map = loadPaneRoutes();
  if (!oracle) return map;
  const key = paneRouteOracleKey(oracle);
  return map[key] ? { [key]: map[key] } : {};
}
