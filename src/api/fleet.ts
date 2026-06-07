import { Elysia } from "elysia";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fleetDirForWrite, fleetDirsForRead, uniqueDirs } from "../core/fleet/paths";

export interface FleetApiDeps {
  fleetDir: string;
  fleetDirs?: string[];
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  join: typeof join;
}

function defaultFleetApiDeps(): FleetApiDeps {
  return {
    fleetDir: fleetDirForWrite(),
    fleetDirs: fleetDirsForRead(),
    readdirSync,
    readFileSync,
    join,
  };
}

function readFleetConfigs(deps: FleetApiDeps): unknown[] {
  const dirs = uniqueDirs(deps.fleetDirs?.length ? deps.fleetDirs : [deps.fleetDir]);
  const seenFiles = new Set<string>();
  const configs: unknown[] = [];
  let sawReadableDir = false;
  let lastError: unknown = null;

  for (const dir of dirs) {
    let files: string[];
    try {
      files = deps.readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled")).sort();
      sawReadableDir = true;
    } catch (e) {
      lastError = e;
      continue;
    }

    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      configs.push(JSON.parse(deps.readFileSync(deps.join(dir, file), "utf-8") as string));
    }
  }

  if (!sawReadableDir && lastError) throw lastError;
  return configs;
}

export function createFleetApi(deps: FleetApiDeps = defaultFleetApiDeps()) {
  const api = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients that compute lineage by inverting `budded_from`.
// See docs/federation.md before changing fields.
  api.get("/fleet-config", () => {
    try {
      return { configs: readFleetConfigs(deps) };
    } catch (e: any) {
      return { configs: [], error: e.message };
    }
  });

  return api;
}

export const fleetApi = createFleetApi();
