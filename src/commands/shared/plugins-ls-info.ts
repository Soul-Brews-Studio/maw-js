/**
 * plugins seam: doLs + doInfo implementations.
 */

import type { LoadedPlugin, PluginTier } from "../../plugin/types";
import { weightToTier } from "../../plugin/tier";
import { existsSync } from "fs";
import { surfaces, shortenHome, printTable } from "./plugins-ui";

/** Resolve effective tier: explicit tier field first, then inferred from weight (#675). */
function effectiveTier(p: LoadedPlugin): PluginTier {
  return p.manifest.tier ?? weightToTier(p.manifest.weight ?? 50);
}

/** Tier color for terminal output. */
function tierIcon(tier: PluginTier, disabled: boolean): string {
  if (disabled) return "\x1b[90m○\x1b[0m";
  switch (tier) {
    case "core": return "\x1b[32m●\x1b[0m";
    case "standard": return "\x1b[36m●\x1b[0m";
    case "extra": return "\x1b[33m●\x1b[0m";
  }
}

export function doLs(json: boolean, showAll: boolean, discover: () => LoadedPlugin[]): void {
  const allPlugins = discover();

  if (json) {
    console.log(
      JSON.stringify(
        allPlugins.map(p => ({
          name: p.manifest.name,
          version: p.manifest.version,
          tier: effectiveTier(p),
          surfaces: surfaces(p),
          dir: p.dir,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (allPlugins.length === 0) {
    console.log("no plugins installed");
    return;
  }

  const { loadConfig } = require("../../config");
  const disabledSet = new Set((loadConfig().disabledPlugins ?? []) as string[]);

  const activeCount = allPlugins.filter(p => !disabledSet.has(p.manifest.name)).length;
  const disabledCount = allPlugins.length - activeCount;
  const plugins = showAll ? allPlugins : allPlugins.filter(p => !disabledSet.has(p.manifest.name));

  if (plugins.length === 0) {
    console.log(`no active plugins. Use --all to see ${disabledCount} disabled.`);
    return;
  }

  // Group by effective tier (#675 — explicit tier field, fallback to weight-inferred)
  const tiers: { label: PluginTier; plugins: LoadedPlugin[] }[] = [
    { label: "core", plugins: [] },
    { label: "standard", plugins: [] },
    { label: "extra", plugins: [] },
  ];

  for (const p of plugins) {
    const t = effectiveTier(p);
    if (t === "core") tiers[0].plugins.push(p);
    else if (t === "standard") tiers[1].plugins.push(p);
    else tiers[2].plugins.push(p);
  }

  for (const tier of tiers) {
    if (tier.plugins.length === 0) continue;
    console.log(`\n\x1b[1m${tier.label}\x1b[0m (${tier.plugins.length})`);
    const rows = tier.plugins.map(p => {
      const t = effectiveTier(p);
      const isDisabled = disabledSet.has(p.manifest.name);
      const icon = tierIcon(t, isDisabled);
      const source = `${icon} ${isDisabled ? "disabled" : t}`;
      return [
        p.manifest.name,
        p.manifest.version,
        source,
        surfaces(p),
        shortenHome(p.dir),
      ];
    });
    printTable(["name", "version", "tier", "surfaces", "dir"], rows);
  }

  if (showAll) {
    console.log(`\n${allPlugins.length} total (${activeCount} active, ${disabledCount} disabled)`);
  } else if (disabledCount > 0) {
    console.log(`\n${activeCount} active. ${disabledCount} disabled — use 'maw plugin ls --all' to see them.`);
  } else {
    console.log(`\n${activeCount} active`);
  }
}

export function doInfo(name: string, discover: () => LoadedPlugin[]): void {
  const plugins = discover();
  const p = plugins.find(x => x.manifest.name === name);
  if (!p) {
    console.error(`plugin not found: ${name}`);
    process.exit(1);
  }

  const m = p.manifest;
  const t = effectiveTier(p);
  console.log(`\x1b[1m${m.name}\x1b[0m  ${m.version}`);
  if (m.description) console.log(`  desc:    ${m.description}`);
  if (m.author)      console.log(`  author:  ${m.author}`);
  console.log(`  sdk:     ${m.sdk}`);
  console.log(`  tier:    ${t}${m.tier ? "" : " (inferred from weight)"}`);
  if (m.cli) {
    const help = m.cli.help ? `  — ${m.cli.help}` : "";
    console.log(`  cli:     ${m.cli.command}${help}`);
  } else if (p.kind === "ts" && p.entryPath) {
    // #899 — community plugins without an explicit `cli` field still
    // dispatch as `maw <name>` via the default-name path in dispatch-match.
    console.log(`  cli:     ${m.name}  (default — no explicit cli field)`);
  }
  if (m.api) {
    console.log(`  api:     ${m.api.path}  [${m.api.methods.join(", ")}]`);
  }
  console.log(`  dir:     ${p.dir}`);

  // #899 — TS plugins execute via Bun import of `entry`, not WASM. Showing a
  // "wasm missing — will not execute" warning for a healthy `target:js` plugin
  // produced false-alarm reports during the source-plugin install cascade.
  // Only warn about wasm when the plugin is actually a WASM kind.
  if (p.kind === "ts" && p.entryPath) {
    const entryExists = existsSync(p.entryPath);
    const mark = entryExists ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ missing\x1b[0m";
    console.log(`  entry:   ${p.entryPath}  ${mark}`);
    if (!entryExists) {
      console.warn(`\x1b[33mwarn:\x1b[0m entry file missing — plugin will not execute`);
    }
  } else {
    const wasmExists = existsSync(p.wasmPath);
    const wasmMark = wasmExists ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ missing\x1b[0m";
    console.log(`  wasm:    ${p.wasmPath}  ${wasmMark}`);
    if (!wasmExists) {
      console.warn(`\x1b[33mwarn:\x1b[0m wasm file missing — plugin will not execute`);
    }
  }
}
