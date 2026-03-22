import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../paths";

export async function cmdCompletions(sub: string) {
  if (sub === "commands") {
    console.log("ls peek hey wake fleet stop done overview about oracle pulse view create-view tab talk-to serve");
  } else if (sub === "oracles" || sub === "windows") {
    const fleetDir = FLEET_DIR;
    const names = new Set<string>();
    try {
      for (const f of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
        const config = JSON.parse(readFileSync(join(fleetDir, f), "utf-8"));
        for (const w of (config.windows || [])) {
          if (sub === "oracles") {
            if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
          } else {
            names.add(w.name);
          }
        }
      }
    } catch {}
    console.log([...names].sort().join("\n"));
  } else if (sub === "fleet") {
    console.log("init ls renumber validate sync");
  } else if (sub === "pulse") {
    console.log("add ls list");
  }
}
