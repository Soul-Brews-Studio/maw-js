import { discoverPackages } from "../plugin/registry";
import { TOP_ALIASES, ALIAS_DESCRIPTIONS } from "./top-aliases";

/**
 * Conceptual grouping for --help output (#1154).
 *
 * Each verb (plugin command or top-level alias) is assigned a category.
 * Groups are rendered in CATEGORY_ORDER. Verbs not in VERB_CATEGORY
 * fall through to "Other" (forward-compat for new plugins).
 */
const CATEGORY_ORDER = ["Sessions", "Look", "Talk", "Window", "Teams", "Oracles", "System"];

const VERB_CATEGORY: Record<string, string> = {
  wake: "Sessions", a: "Sessions", sleep: "Sessions", stop: "Sessions", kill: "Sessions",
  ls: "Look", panes: "Look", peek: "Look", health: "Look",
  run: "Talk", send: "Talk", "send-enter": "Talk",
  split: "Window", open: "Window", close: "Window", layout: "Window", zoom: "Window", take: "Window", done: "Window",
  t: "Teams", swarm: "Teams", cleanup: "Teams",
  oracle: "Oracles", bud: "Oracles", contacts: "Oracles", ping: "Oracles",
  init: "System", preflight: "System",
};

interface VerbEntry {
  verb: string;
  desc: string;
  isAlias: boolean;
  canonical?: string;
}

function getCanonical(verb: string): string | undefined {
  const entry = TOP_ALIASES[verb];
  if (!entry) return undefined;
  if (Array.isArray(entry)) return entry.join(" ");
  return undefined;
}

export function usage() {
  const title = `\x1b[36mmaw\x1b[0m — Multi-Agent Workflow`;

  try {
    const all = discoverPackages();
    const active = all.filter(p => !p.disabled && p.manifest.cli?.command);
    const hasDisabled = all.some(p => p.disabled);

    const pluginNames = new Set(active.map(p => p.manifest.cli!.command));
    const aliasEntries = Object.entries(TOP_ALIASES);

    // Build unified verb list
    const verbs: VerbEntry[] = [];

    // Plugins first
    for (const p of active) {
      const verb = p.manifest.cli!.command;
      verbs.push({ verb, desc: p.manifest.description ?? "", isAlias: false });
    }

    // Aliases that aren't already a plugin
    for (const [verb] of aliasEntries) {
      if (pluginNames.has(verb)) continue;
      verbs.push({
        verb,
        desc: ALIAS_DESCRIPTIONS[verb] ?? "",
        isAlias: true,
        canonical: getCanonical(verb),
      });
    }

    // Group by category
    const groups = new Map<string, VerbEntry[]>();
    for (const cat of [...CATEGORY_ORDER, "Other"]) groups.set(cat, []);

    for (const v of verbs) {
      const cat = VERB_CATEGORY[v.verb] || "Other";
      groups.get(cat)!.push(v);
    }

    // Render
    const lines: string[] = [title, ""];
    let verbCount = 0;
    let aliasCount = 0;

    for (const cat of [...CATEGORY_ORDER, "Other"]) {
      const entries = groups.get(cat)!;
      if (entries.length === 0) continue;

      const preview = entries.map(e => e.verb).join(", ");
      lines.push(`  \x1b[33m${cat}\x1b[0m  \x1b[90m${preview}\x1b[0m`);

      for (const e of entries) {
        if (e.isAlias) aliasCount++; else verbCount++;
        const marker = e.isAlias ? "↳" : " ";
        const label = `${marker} ${e.verb}`.padEnd(22);
        const suffix = e.isAlias && e.canonical ? `\x1b[90m→ ${e.canonical}\x1b[0m` : "";
        lines.push(`    ${label} ${e.desc}${suffix ? `  ${suffix}` : ""}`);
      }
      lines.push("");
    }

    const hiddenCount = hasDisabled ? all.filter(p => p.disabled).length : 0;
    const footer = hiddenCount > 0
      ? `\x1b[90m${verbCount} commands · ${aliasCount} aliases · ${hiddenCount} hidden (maw plugin enable <name>)\x1b[0m`
      : `\x1b[90m${verbCount} commands · ${aliasCount} aliases\x1b[0m`;
    lines.push(footer);

    console.log(lines.join("\n"));
  } catch {
    console.log(`${title}\n\nRun \x1b[33mmaw plugin ls\x1b[0m to see available commands.`);
  }
}
