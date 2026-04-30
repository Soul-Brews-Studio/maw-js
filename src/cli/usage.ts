import { discoverPackages } from "../plugin/registry";
import { TOP_ALIASES, ALIAS_DESCRIPTIONS } from "./top-aliases";

export function usage() {
  const title = `\x1b[36mmaw\x1b[0m — Multi-Agent Workflow`;

  try {
    const all = discoverPackages();
    const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
    const hasDisabled = all.some(p => p.disabled);

    const tiers = [
      { name: "core",     plugins: active.filter(p => (p.manifest.weight ?? 50) < 10) },
      { name: "standard", plugins: active.filter(p => { const w = p.manifest.weight ?? 50; return w >= 10 && w < 50; }) },
      { name: "extra",    plugins: active.filter(p => (p.manifest.weight ?? 50) >= 50) },
    ].filter(t => t.plugins.length > 0);

    const multiTier = tiers.length > 1;
    const lines: string[] = [title, ""];

    const aliasEntries = Object.entries(TOP_ALIASES);
    const pluginNames = new Set(active.map(p => p.manifest.cli!.command));

    let aliasesInserted = false;
    for (const tier of tiers) {
      const label = multiTier
        ? `\x1b[33m${tier.name} (${tier.plugins.length}):\x1b[0m`
        : `\x1b[33m${tier.name}:\x1b[0m`;
      lines.push(label);
      for (const p of tier.plugins) {
        const cmd = `maw ${p.manifest.cli!.command}`.padEnd(28);
        const desc = p.manifest.description ?? "";
        lines.push(`  ${cmd} ${desc}`);
      }

      if (!aliasesInserted && tier.name === "core" && aliasEntries.length > 0) {
        for (const [verb] of aliasEntries) {
          if (pluginNames.has(verb)) continue;
          const cmd = `maw ${verb}`.padEnd(28);
          const desc = ALIAS_DESCRIPTIONS[verb] ?? "";
          lines.push(`  ${cmd} ${desc}`);
        }
        aliasesInserted = true;
      }
      lines.push("");
    }

    if (!aliasesInserted && aliasEntries.length > 0) {
      for (const [verb] of aliasEntries) {
        if (pluginNames.has(verb)) continue;
        const cmd = `maw ${verb}`.padEnd(28);
        const desc = ALIAS_DESCRIPTIONS[verb] ?? "";
        lines.push(`  ${cmd} ${desc}`);
      }
      lines.push("");
    }

    const total = active.length + aliasEntries.filter(([v]) => !pluginNames.has(v)).length;
    const countLine = hasDisabled
      ? `\x1b[90m${total} commands active. Run 'maw plugin enable <name>' for more.\x1b[0m`
      : `\x1b[90m${total} commands active.\x1b[0m`;
    lines.push(countLine);

    console.log(lines.join("\n"));
  } catch {
    console.log(`${title}\n\nRun \x1b[33mmaw plugin ls\x1b[0m to see available commands.`);
  }
}
