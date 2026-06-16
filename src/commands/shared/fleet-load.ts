import * as sdk from "../../sdk";
import {
  fleetDirForWrite,
  fleetDirsForRead as coreFleetDirsForRead,
  loadFleet as loadFleetCore,
  countDisabledFleetFiles as countDisabledFleetFilesCore,
  loadDisabledFleetEntries as loadDisabledFleetEntriesCore,
  loadFleetEntries as loadFleetEntriesCore,
  type DisabledFleetEntry,
  type FleetEntry,
  type FleetSession,
  type FleetWindow,
} from "../../core/fleet/fleet-load-core";
import { resolveFleetWindowSessionTarget } from "../../core/matcher/resolve-target";

export type { DisabledFleetEntry, FleetEntry, FleetSession, FleetWindow };

export function fleetDirsForRead(): string[] {
  return coreFleetDirsForRead((sdk as any).FLEET_DIR as string | undefined);
}

export { fleetDirForWrite };

export function loadFleet(dirs: string[] = fleetDirsForRead()): FleetSession[] {
  return loadFleetCore(dirs);
}

export function countDisabledFleetFiles(dirs: string[] = fleetDirsForRead()): number {
  return countDisabledFleetFilesCore(dirs);
}

export function loadDisabledFleetEntries(dirs: string[] = fleetDirsForRead()): DisabledFleetEntry[] {
  return loadDisabledFleetEntriesCore(dirs);
}

export function loadFleetEntries(dirs: string[] = fleetDirsForRead()): FleetEntry[] {
  return loadFleetEntriesCore(dirs);
}

export async function getSessionNames(): Promise<string[]> {
  try {
    const out = await sdk.tmux.run("list-sessions", "-F", "#{session_name}");
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

/**
 * Oracle name → fleet session name via the fleet config (#281).
 *
 * Lives here (not in wake-resolve-impl) so the hot, sync `resolveTarget`
 * path can pull it WITHOUT dragging the whole wake subsystem — wake-resolve-impl
 * statically `import { hostExec, tmux } from "../../sdk"`, which made any test
 * partial-mocking the sdk barrel fail to link (the release blocker on
 * v26.6.5-alpha.1323). This module only uses `import * as sdk` (namespace —
 * link-safe), and resolveFleetSession itself touches neither hostExec nor tmux.
 */
export function resolveFleetSession(oracle: string): string | null {
  try {
    const resolved = resolveFleetWindowSessionTarget(oracle, loadFleet());
    if (resolved.kind === "fuzzy" || resolved.kind === "exact") return resolved.match.name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("invalid fleet JSON ")) throw error;
    /* fleet dir may not exist */
  }
  return null;
}
