import { Elysia } from "elysia";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR as fleetDir } from "../core/paths";

export interface FleetApiDeps {
  fleetDir: string;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  join: typeof join;
}

export function createFleetApi(deps: FleetApiDeps = {
  fleetDir,
  readdirSync,
  readFileSync,
  join,
}) {
  const api = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients that compute lineage by inverting `budded_from`.
// See docs/federation.md before changing fields.
  api.get("/fleet-config", () => {
    try {
      const files = deps.readdirSync(deps.fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
      const configs = files.map(f => JSON.parse(deps.readFileSync(deps.join(deps.fleetDir, f), "utf-8") as string));
      return { configs };
    } catch (e: any) {
      return { configs: [], error: e.message };
    }
  });

  return api;
}

export const fleetApi = createFleetApi();
