import { FLEET_DIR } from "../paths";
import { mawStatePath } from "../xdg";

export function uniqueDirs(dirs: string[]): string[] {
  return [...new Set(dirs.filter(Boolean))];
}

export interface FleetPathRoots {
  stateFleetDir?: string;
  legacyFleetDir?: string;
}

export function fleetDirsForRead(roots: FleetPathRoots = {}): string[] {
  return uniqueDirs([roots.stateFleetDir ?? mawStatePath("fleet"), roots.legacyFleetDir ?? FLEET_DIR]);
}

export function fleetDirForWrite(roots: Pick<FleetPathRoots, "stateFleetDir"> = {}): string {
  return roots.stateFleetDir ?? mawStatePath("fleet");
}

export function fleetDirsFromOverrides(fleetDir?: string, fleetDirs?: string[], roots: FleetPathRoots = {}): string[] {
  return fleetDirs?.length ? uniqueDirs(fleetDirs) : fleetDir ? [fleetDir] : fleetDirsForRead(roots);
}
