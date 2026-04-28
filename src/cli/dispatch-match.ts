/**
 * Plugin dispatch matching — two-pass (exact before prefix).
 *
 * Fixes #351 + #350: the prior single-pass loop fired on the first plugin
 * whose command or alias matched as exact OR prefix, so iteration order
 * could route `art` to a prefix-collider instead of `art`'s exact owner,
 * and could mask an exact match behind an earlier prefix match.
 *
 * Resolution order:
 *   1. Collect all exact `cmdName === name` matches.
 *   2. If pass-1 empty, collect all `cmdName startsWith (name + " ")` matches.
 *   3. Single survivor → match. Multi survivors → ambiguous (caller reports).
 *
 * #899: source-plugin execution dispatch. Community plugins installed via
 * `maw plugin install` may omit the `cli` field in plugin.json — every
 * existing community plugin was extracted that way (shellenv, bg, rename,
 * cross-team-queue, park). Per the issue's stated runtime contract, the
 * dispatcher defaults the CLI command to `manifest.name` when the field is
 * absent. The plugin still needs an entry/wasm to actually execute (gated
 * by `isDispatchable` below), so headless plugins (api-only, hooks-only,
 * cron-only) remain skipped — we only inject a default for plugins that
 * could meaningfully respond to a CLI invocation.
 */
import type { LoadedPlugin } from "../plugin/types";

export type DispatchMatch =
  | { kind: "match"; plugin: LoadedPlugin; matchedName: string }
  | { kind: "ambiguous"; candidates: Array<{ plugin: string; name: string }> }
  | { kind: "none" };

/**
 * #899: a plugin is CLI-dispatchable if it has either a JS/TS entry or a
 * WASM module. Pure-API / pure-hooks / pure-cron plugins (no entry, no wasm,
 * no artifact) are not dispatchable — the default-cli-name path skips them
 * so unknown commands still error correctly instead of silently matching a
 * headless plugin and crashing inside invokePlugin.
 */
function isDispatchable(p: LoadedPlugin): boolean {
  if (p.kind === "ts" && p.entryPath) return true;
  if (p.kind === "wasm" && p.wasmPath) return true;
  return false;
}

/**
 * #899: derive the CLI command names for a plugin. If `manifest.cli` is
 * present, use it (canonical command + aliases). Otherwise default to
 * `manifest.name` IFF the plugin is dispatchable. Returns `null` for
 * plugins that should not participate in CLI dispatch.
 */
export function pluginCliNames(p: LoadedPlugin): { command: string; aliases: string[] } | null {
  if (p.manifest.cli) {
    return {
      command: p.manifest.cli.command,
      aliases: p.manifest.cli.aliases ?? [],
    };
  }
  if (!isDispatchable(p)) return null;
  return { command: p.manifest.name, aliases: [] };
}

export function resolvePluginMatch(
  plugins: LoadedPlugin[],
  cmdName: string,
): DispatchMatch {
  type Hit = { plugin: LoadedPlugin; matchedName: string };
  const exact: Hit[] = [];
  const prefix: Hit[] = [];
  for (const p of plugins) {
    const cliNames = pluginCliNames(p);
    if (!cliNames) continue;
    const names = [cliNames.command, ...cliNames.aliases];
    let exactHit: string | null = null;
    let prefixHit: string | null = null;
    for (const n of names) {
      const lower = n.toLowerCase();
      if (cmdName === lower) { exactHit = lower; break; }
      if (!prefixHit && cmdName.startsWith(lower + " ")) prefixHit = lower;
    }
    if (exactHit) exact.push({ plugin: p, matchedName: exactHit });
    else if (prefixHit) prefix.push({ plugin: p, matchedName: prefixHit });
  }
  const winners = exact.length > 0 ? exact : prefix;
  if (winners.length === 0) return { kind: "none" };
  if (winners.length === 1) return { kind: "match", plugin: winners[0].plugin, matchedName: winners[0].matchedName };
  return {
    kind: "ambiguous",
    candidates: winners.map(w => ({ plugin: w.plugin.manifest.name, name: w.matchedName })),
  };
}
