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
 */
import type { LoadedPlugin } from "../plugin/types";

export type DispatchMatch =
  | { kind: "match"; plugin: LoadedPlugin; matchedName: string }
  | { kind: "ambiguous"; candidates: Array<{ plugin: string; name: string }> }
  | { kind: "none" };

export function resolvePluginMatch(
  plugins: LoadedPlugin[],
  cmdName: string,
): DispatchMatch {
  type Hit = { plugin: LoadedPlugin; matchedName: string };
  const exact: Hit[] = [];
  const prefix: Hit[] = [];
  for (const p of plugins) {
    if (!p.manifest.cli) continue;
    const names = [p.manifest.cli.command, ...(p.manifest.cli.aliases ?? [])];
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
