/**
 * plugins seam: doLs + doInfo implementations.
 */

import type { LoadedPlugin, PluginTier } from "../../plugin/types";
import { weightToTier } from "../../plugin/tier";
import { existsSync } from "fs";
import { surfaces, shortenHome, printTable } from "./plugins-ui";

export interface PluginLsOptions {
  verbose?: boolean;
  tiers?: PluginTier[];
  apiOnly?: boolean;
}

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

function hasApiSurface(p: LoadedPlugin): boolean {
  return !!p.manifest.api;
}

function hasCliSurface(p: LoadedPlugin): boolean {
  return !!p.manifest.cli || !!p.entryPath || (p.kind === "wasm" && !!p.wasmPath);
}

function missingExecutable(p: LoadedPlugin): boolean {
  if (p.kind === "ts" && p.entryPath) return !existsSync(p.entryPath);
  return !!p.wasmPath && !existsSync(p.wasmPath);
}

function applyLsFilters(plugins: LoadedPlugin[], options: PluginLsOptions): LoadedPlugin[] {
  const selectedTiers = new Set(options.tiers ?? []);
  return plugins.filter((p) => {
    if (selectedTiers.size > 0 && !selectedTiers.has(effectiveTier(p))) return false;
    if (options.apiOnly && !hasApiSurface(p)) return false;
    return true;
  });
}

function filterLabel(options: PluginLsOptions): string {
  const parts = [
    ...(options.tiers ?? []),
    ...(options.apiOnly ? ["api"] : []),
  ];
  return parts.length ? ` matching ${parts.join("+")}` : "";
}

function tierCounts(plugins: LoadedPlugin[]): Record<PluginTier, number> {
  return plugins.reduce<Record<PluginTier, number>>((acc, p) => {
    acc[effectiveTier(p)]++;
    return acc;
  }, { core: 0, standard: 0, extra: 0 });
}

function printCompactSummary(
  filteredAll: LoadedPlugin[],
  displayPlugins: LoadedPlugin[],
  activeCount: number,
  disabledCount: number,
  showAll: boolean,
  options: PluginLsOptions,
): void {
  const counts = tierCounts(displayPlugins);
  const apiCount = displayPlugins.filter(hasApiSurface).length;
  const cliCount = displayPlugins.filter(hasCliSurface).length;
  const missingCount = displayPlugins.filter(missingExecutable).length;
  const health = missingCount === 0
    ? "ok"
    : `${missingCount} missing executable${missingCount === 1 ? "" : "s"}`;

  console.log(`${filteredAll.length} plugin${filteredAll.length === 1 ? "" : "s"} (${activeCount} active, ${disabledCount} disabled)${filterLabel(options)}`);
  console.log(`  core: ${counts.core} · standard: ${counts.standard} · extra: ${counts.extra}`);
  console.log(`  cli: ${cliCount} · api: ${apiCount} · health: ${health}`);
  if (!showAll && disabledCount > 0) {
    console.log("  disabled hidden by default — use --all to include; use -v for full table");
  }
}

export function doLs(
  json: boolean,
  showAll: boolean,
  discover: () => LoadedPlugin[],
  load: () => { disabledPlugins?: string[] } = () => {
    const { loadConfig } = require("../../config");
    return loadConfig();
  },
  options: PluginLsOptions = {},
): void {
  const allPlugins = discover();
  const filteredAll = applyLsFilters(allPlugins, options);

  if (json) {
    console.log(
      JSON.stringify(
        filteredAll.map(p => ({
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

  const disabledSet = new Set((load().disabledPlugins ?? []) as string[]);

  const activeCount = filteredAll.filter(p => !disabledSet.has(p.manifest.name)).length;
  const disabledCount = filteredAll.length - activeCount;
  const plugins = showAll ? filteredAll : filteredAll.filter(p => !disabledSet.has(p.manifest.name));

  if (plugins.length === 0) {
    if (filteredAll.length === 0) {
      console.log(`no plugins${filterLabel(options)}.`);
    } else {
      console.log(`no active plugins${filterLabel(options)}. Use --all to see ${disabledCount} disabled.`);
    }
    return;
  }

  if (!options.verbose) {
    printCompactSummary(filteredAll, plugins, activeCount, disabledCount, showAll, options);
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
    tier.plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
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
