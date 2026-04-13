import { Elysia } from "elysia";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR as fleetDir } from "../paths";

export const fleetApi = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients that compute lineage by inverting `budded_from`.
// See docs/federation.md before changing fields.
fleetApi.get("/fleet-config", () => {
  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => JSON.parse(readFileSync(join(fleetDir, f), "utf-8")));
    return { configs };
  } catch (e: any) {
    return { configs: [], error: e.message };
  }
});
