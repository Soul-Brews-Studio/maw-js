import { discoverPackages } from "../plugin/registry";
import { TOP_ALIASES } from "./top-aliases";

export function usage() {
  const title = `\x1b[36mmaw\x1b[0m — Multi-Agent Workflow`;

  try {
    const all = discoverPackages();
    const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
    const hasDisabled = all.some(p => p.disabled);

    // Group by weight tier: core < 10, standard 10-49, extra 50+
    const tiers = [
      { name: "core",     plugins: active.filter(p => (p.manifest.weight ?? 50) < 10) },
      { name: "standard", plugins: active.filter(p => { const w = p.manifest.weight ?? 50; return w >= 10 && w < 50; }) },
      { name: "extra",    plugins: active.filter(p => (p.manifest.weight ?? 50) >= 50) },
    ].filter(t => t.plugins.length > 0);

    const multiTier = tiers.length > 1;
    const lines: string[] = [title, ""];

    // RFC #954 — top-level aliases between core and standard tiers.
    // Render once after the core tier (or first tier) so users see
    // the verb-prominence surface alongside the canonical plugins.
    const aliasEntries = Object.entries(TOP_ALIASES);
    const renderAliases = () => {
      lines.push(`\x1b[33maliases (${aliasEntries.length}):\x1b[0m`);
      for (const [verb, target] of aliasEntries) {
        const cmd = `maw ${verb}`.padEnd(28);
        let arrow: string;
        if (Array.isArray(target)) {
          arrow = `→ maw ${target.join(" ")}`;
        } else {
          // Direct-handler form: extract just the export name for readability.
          const exportName = target.handler.split(":").pop() ?? target.handler;
          arrow = `→ direct handler: ${exportName}`;
        }
        lines.push(`  ${cmd} ${arrow}`);
      }
      lines.push("");
    };

    let aliasesRendered = false;
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
      lines.push("");
      // Insert aliases section immediately after the core tier (RFC §Q3).
      if (!aliasesRendered && tier.name === "core" && aliasEntries.length > 0) {
        renderAliases();
        aliasesRendered = true;
      }
    }
    // Fallback: if no `core` tier was rendered (e.g. minimal profile), still
    // surface the aliases block at the end so users don't lose access.
    if (!aliasesRendered && aliasEntries.length > 0) renderAliases();

    const countLine = hasDisabled
      ? `\x1b[90m${active.length} commands active. Run 'maw plugin enable <name>' for more.\x1b[0m`
      : `\x1b[90m${active.length} commands active.\x1b[0m`;
    lines.push(countLine);

    console.log(lines.join("\n"));
  } catch {
    // Registry not loaded yet — minimal fallback
    console.log(`${title}\n\nRun \x1b[33mmaw plugin ls\x1b[0m to see available commands.`);
  }
}
