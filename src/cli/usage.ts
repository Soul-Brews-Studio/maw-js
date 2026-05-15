import { discoverPackages } from "../plugin/registry";
import type { LoadedPlugin } from "../plugin/types";
import { TOP_ALIASES, ALIAS_DESCRIPTIONS, type DirectHandler } from "./top-aliases";

type AliasTarget = string[] | DirectHandler;
type AliasGroup = { label: string; descKey: string };
const TITLE = `\x1b[36mmaw\x1b[0m — Multi-Agent Workflow`;

function aliasKey(target: AliasTarget): string {
  return Array.isArray(target) ? `argv:${target.join(" ")}` : `dir:${target.handler}`;
}

function canonicalAliasLabel(verbs: string[], target: AliasTarget): string {
  if (Array.isArray(target) && target.length === 1) {
    const [head] = target;
    if (head && head !== verbs[0]) return head;
  }
  return [...verbs].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? verbs[0] ?? "";
}

function displayLabel(primary: string, aliases: string[]): string {
  return aliases.length > 0 ? `${primary} (${aliases.join(", ")})` : primary;
}

export function formatUsage(all: LoadedPlugin[]): string {
  const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
  const hasDisabled = all.some(p => p.disabled);

  const tiers = [
    { name: "core",     plugins: active.filter(p => (p.manifest.weight ?? 50) < 10) },
    { name: "standard", plugins: active.filter(p => { const w = p.manifest.weight ?? 50; return w >= 10 && w < 50; }) },
    { name: "extra",    plugins: active.filter(p => (p.manifest.weight ?? 50) >= 50) },
  ].filter(t => t.plugins.length > 0);

  const multiTier = tiers.length > 1;
  const lines: string[] = [TITLE, ""];

  const aliasEntries = Object.entries(TOP_ALIASES);
  const pluginNames = new Set(active.map(p => p.manifest.cli!.command));
  const pluginAliases = new Map<string, string[]>();
  const aliasGroups = new Map<string, { target: AliasTarget; verbs: string[] }>();

  for (const [verb, target] of aliasEntries) {
    if (pluginNames.has(verb)) continue;

    if (Array.isArray(target)) {
      const [head, subcommand] = target;
      const pluginTarget = target.length === 1 && head !== verb && pluginNames.has(head)
        ? head
        : target.length === 2 && head === "tmux" && subcommand && pluginNames.has(subcommand)
          ? subcommand
          : null;
      if (pluginTarget) {
        pluginAliases.set(pluginTarget, [...(pluginAliases.get(pluginTarget) ?? []), verb]);
        continue;
      }
    }

    const key = aliasKey(target);
    const group = aliasGroups.get(key) ?? { target, verbs: [] };
    group.verbs.push(verb);
    aliasGroups.set(key, group);
  }

  const aliasRows: AliasGroup[] = [];
  for (const { target, verbs } of aliasGroups.values()) {
    const primary = canonicalAliasLabel(verbs, target);
    const aliases = verbs.filter(verb => verb !== primary);
    const descKey = ALIAS_DESCRIPTIONS[primary] ? primary : verbs[0] ?? primary;
    aliasRows.push({ label: displayLabel(primary, aliases), descKey });
  }

  let aliasesInserted = false;
  for (const tier of tiers) {
    const rowCount = tier.plugins.length + (!aliasesInserted && tier.name === "core" ? aliasRows.length : 0);
    const label = multiTier
      ? `\x1b[33m${tier.name} (${rowCount}):\x1b[0m`
      : `\x1b[33m${tier.name}:\x1b[0m`;
    lines.push(label);
    for (const p of tier.plugins) {
      const command = p.manifest.cli!.command;
      const aliases = pluginAliases.get(command) ?? [];
      const display = displayLabel(command, aliases);
      const cmd = `maw ${display}`.padEnd(28);
      const desc = p.manifest.description ?? "";
      lines.push(`  ${cmd} ${desc}`);
    }

    if (!aliasesInserted && tier.name === "core" && aliasRows.length > 0) {
      for (const row of aliasRows) {
        const cmd = `maw ${row.label}`.padEnd(28);
        const desc = ALIAS_DESCRIPTIONS[row.descKey] ?? "";
        lines.push(`  ${cmd} ${desc}`);
      }
      aliasesInserted = true;
    }
    lines.push("");
  }

  if (!aliasesInserted && aliasRows.length > 0) {
    for (const row of aliasRows) {
      const cmd = `maw ${row.label}`.padEnd(28);
      const desc = ALIAS_DESCRIPTIONS[row.descKey] ?? "";
      lines.push(`  ${cmd} ${desc}`);
    }
    lines.push("");
  }

  const total = active.length + aliasRows.length;
  const countLine = hasDisabled
    ? `\x1b[90m${total} commands active. Run 'maw plugin enable <name>' for more.\x1b[0m`
    : `\x1b[90m${total} commands active.\x1b[0m`;
  lines.push(countLine);

  return lines.join("\n");
}

export function usage() {
  try {
    console.log(formatUsage(discoverPackages()));
  } catch {
    console.log(`${TITLE}\n\nRun \x1b[33mmaw plugin ls\x1b[0m to see available commands.`);
  }
}
