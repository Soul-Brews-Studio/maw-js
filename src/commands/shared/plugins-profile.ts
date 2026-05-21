/**
 * plugins seam: doProfile + doNuke implementations.
 * DO NOT change profile thresholds/logic — lean/standard/full were just shipped.
 */

import type { LoadedPlugin } from "../../plugin/types";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { archiveToTmp } from "./plugins-ui";
import { mawDataPath } from "../../core/xdg";

function getPluginHome(): string {
  return process.env.MAW_PLUGIN_HOME ?? mawDataPath("plugins");
}

export function doProfile(profile: "core" | "standard" | "full", discover: () => LoadedPlugin[]): void {
  const { loadConfig, saveConfig } = require("../../config");
  const plugins = discover();

  if (profile === "full") {
    saveConfig({ disabledPlugins: [] });
    console.log(`\n\x1b[32m✓\x1b[0m full — all ${plugins.length} plugins enabled`);
    return;
  }

  // core: keep weight < 10. standard: keep weight < 50 (core + standard tiers).
  const threshold = profile === "core" ? 10 : 50;
  const toDisable: string[] = [];
  for (const p of plugins) {
    if ((p.manifest.weight ?? 50) >= threshold) toDisable.push(p.manifest.name);
  }

  if (toDisable.length === 0) {
    console.log(`already ${profile} — nothing to disable`);
    return;
  }

  const config = loadConfig();
  // Reset disabled list (don't accumulate from previous profile)
  saveConfig({ disabledPlugins: toDisable });

  for (const n of toDisable) console.log(`  \x1b[33m✗\x1b[0m ${n}`);
  const remaining = plugins.length - toDisable.length;
  console.log(`\n\x1b[32m✓\x1b[0m ${profile} — ${remaining} active, ${toDisable.length} disabled`);
  console.log(`\x1b[90m  Profiles: maw plugin lean | standard | full\x1b[0m`);
}

export function doNuke(): void {
  const home = getPluginHome();
  if (!existsSync(home)) { console.log("nothing to nuke"); return; }
  const dirs = readdirSync(home);

  for (const d of dirs) {
    const dir = join(home, d);
    const stat = require("fs").lstatSync(dir);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    archiveToTmp(d, dir);
    console.log(`  \x1b[31m✗\x1b[0m ${d}`);
  }

  console.log(`\n\x1b[31m💥\x1b[0m nuked — all plugins archived to /tmp/`);
  console.log(`\x1b[90m   next maw run will auto-bootstrap core plugins\x1b[0m`);
}
