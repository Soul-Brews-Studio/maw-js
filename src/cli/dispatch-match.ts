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

export interface ResolvePluginMatchOptions {
  includeDisabled?: boolean;
}

/**
 * #899: a plugin is CLI-dispatchable if it has either an explicit `cli`
 * manifest or an implicit legacy command surface. The implicit path exists
 * for old source plugins that shipped `entry`/`wasm` but no `cli`. It must
 * NOT catch strategy/API/module/hook surfaces such as attach-ssh or
 * cross-team-queue: those have executable implementation files, but they are
 * invoked by another host surface, not as `maw <plugin-name>`.
 */
function hasExecutableSurface(p: LoadedPlugin): boolean {
  if (p.kind === "ts" && p.entryPath) return true;
  if (p.kind === "wasm" && p.wasmPath) return true;
  return false;
}

function hasNonCliSurface(p: LoadedPlugin): boolean {
  const m = p.manifest;
  return Boolean(
    m.api ||
    m.hooks ||
    m.cron ||
    m.module ||
    m.transport ||
    (m.capabilities && m.capabilities.length > 0),
  );
}

function isImplicitCliDispatchable(p: LoadedPlugin): boolean {
  return hasExecutableSurface(p) && !hasNonCliSurface(p);
}

export function pluginNonCliSurfaces(p: LoadedPlugin): string[] {
  const m = p.manifest;
  const surfaces: string[] = [];
  if (m.api) surfaces.push(`api:${m.api.methods.join("/")} ${m.api.path}`);
  if (m.capabilities?.length) surfaces.push(`capability:${m.capabilities.join(",")}`);
  if (m.hooks) surfaces.push(`hooks:${Object.keys(m.hooks).join(",")}`);
  if (m.cron) surfaces.push(`cron:${m.cron.schedule}`);
  if (m.module) surfaces.push(`module:${m.module.exports.join(",")}`);
  if (m.transport?.peer) surfaces.push("peer");
  return surfaces;
}

/**
 * #899: derive the CLI command names for a plugin. If `manifest.cli` is
 * present, use it (canonical command + aliases). Otherwise default to
 * `manifest.name` IFF the plugin is an implicit legacy CLI plugin. Returns
 * `null` for plugins that should not participate in CLI dispatch.
 */
export function pluginCliNames(p: LoadedPlugin): { command: string; aliases: string[] } | null {
  if (p.manifest.cli) {
    return {
      command: p.manifest.cli.command,
      aliases: p.manifest.cli.aliases ?? [],
    };
  }
  if (!isImplicitCliDispatchable(p)) return null;
  return { command: p.manifest.name, aliases: [] };
}

export function resolvePluginMatch(
  plugins: LoadedPlugin[],
  cmdName: string,
  options: ResolvePluginMatchOptions = {},
): DispatchMatch {
  type Hit = { plugin: LoadedPlugin; matchedName: string };
  const exactCommand: Hit[] = [];
  const exactAlias: Hit[] = [];
  const prefixCommand: Hit[] = [];
  const prefixAlias: Hit[] = [];
  for (const p of plugins) {
    if (p.disabled && !options.includeDisabled) continue;
    const cliNames = pluginCliNames(p);
    if (!cliNames) continue;

    const command = cliNames.command.toLowerCase();
    if (cmdName === command) {
      exactCommand.push({ plugin: p, matchedName: command });
      continue;
    }
    if (cmdName.startsWith(command + " ")) {
      prefixCommand.push({ plugin: p, matchedName: command });
      continue;
    }

    let aliasExactHit: string | null = null;
    let aliasPrefixHit: string | null = null;
    for (const alias of cliNames.aliases) {
      const lower = alias.toLowerCase();
      if (cmdName === lower) { aliasExactHit = lower; break; }
      if (!aliasPrefixHit && cmdName.startsWith(lower + " ")) aliasPrefixHit = lower;
    }
    if (aliasExactHit) exactAlias.push({ plugin: p, matchedName: aliasExactHit });
    else if (aliasPrefixHit) prefixAlias.push({ plugin: p, matchedName: aliasPrefixHit });
  }
  const winners =
    exactCommand.length > 0 ? exactCommand
      : exactAlias.length > 0 ? exactAlias
        : prefixCommand.length > 0 ? prefixCommand
          : prefixAlias;
  if (winners.length === 0) return { kind: "none" };
  if (winners.length === 1) return { kind: "match", plugin: winners[0].plugin, matchedName: winners[0].matchedName };
  return {
    kind: "ambiguous",
    candidates: winners.map(w => ({ plugin: w.plugin.manifest.name, name: w.matchedName })),
  };
}
