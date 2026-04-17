import { loadConfig } from "../../../config";
import { parseWakeTarget, ensureCloned } from "../../shared/wake-target";
import { normalizeTarget } from "../../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../../core/fleet/validate";
import { hostExec } from "../../../sdk";
import { ensureBudRepo } from "./bud-repo";
import { initVault, generateClaudeMd, configureFleet, writeBirthNote } from "./bud-init";
import { finalizeBud } from "./bud-wake";
import { writeSignal } from "../../../core/fleet/leaf";
import { join } from "path";

export interface BudOpts {
  from?: string;
  repo?: string;
  org?: string;
  issue?: number;
  fast?: boolean;
  root?: boolean;
  dryRun?: boolean;
  note?: string;
  split?: boolean;
  /** @deprecated Use --seed for explicit inheritance. Birth is blank by default now. */
  blank?: boolean;
  /** Opt-in: pre-load parent's ψ at birth (bulk push). Default is blank — child
   *  pulls memory later via `maw soul-sync <parent> --from` after /awaken. */
  seed?: boolean;
  /** Drop a "birth" signal into the parent oracle's ψ/memory/signals/ on creation. */
  signalOnBirth?: boolean;
}

// TinyBudOpts removed — --tiny deprecated, code moved to deprecated/tiny-bud-209/
// See #209 for history. Full buds with --blank (alpha.38) are now as lightweight.

/**
 * maw bud <name> [--from <parent>] [--org <org>] [--repo org/repo] [--issue N] [--fast] [--dry-run]
 *
 * Yeast budding — any oracle can spawn a new oracle.
 *
 * Target org resolution (first wins):
 *   1. --org <org>                    — per-invocation override (#235)
 *   2. config.githubOrg               — per-machine default from config
 *   3. "Soul-Brews-Studio"            — hard-coded fallback
 *
 * Note: --repo is an INCUBATION flag (seeds the bud from an existing local
 * project's ψ/), NOT a target-org override. Use --org to target a different
 * GitHub org for the bud's own repo.
 */
export async function cmdBud(name: string, opts: BudOpts = {}) {
  // Canonicalize first — drop trailing `/`, `/.git`, `/.git/` from tab-completion/paste.
  name = normalizeTarget(name);
  // Oracle names: alphanumeric + hyphens only, must start with a letter
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) {
    throw new Error(
      `invalid oracle name: "${name}" — names must start with a letter and contain only letters, numbers, hyphens`,
    );
  }
  // #358 — reject -view suffix (reserved for ephemeral grouped sessions).
  try {
    assertValidOracleName(name);
  } catch (e: any) {
    throw new Error(e.message);
  }

  // Runtime guard: stem must NOT end with -oracle (the plugin auto-appends it).
  // This prevents arra-oracle-v3 → arra-oracle-v3-oracle (correct)
  // from being confused with arra-oracle-v3-oracle → arra-oracle-v3-oracle-oracle (triple).
  if (name.endsWith("-oracle")) {
    throw new Error(
      `\x1b[31m✗\x1b[0m bud stem must NOT end with '-oracle' — got '${name}'\n` +
      `  The plugin auto-appends '-oracle' to produce the repo name.\n` +
      `  Try: maw bud ${name.replace(/-oracle$/, "")}\n` +
      `  This produces repo: ${name.replace(/-oracle$/, "")}-oracle`,
    );
  }

  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const org = opts.org || config.githubOrg || "Soul-Brews-Studio";

  // Resolve parent oracle (skip for --root)
  let parentName: string | null = opts.from || null;
  // If --from is a URL or org/repo slug, extract oracle name and clone (#280)
  const fromTarget = parentName ? parseWakeTarget(parentName) : null;
  if (fromTarget) {
    parentName = fromTarget.oracle;
    if (!opts.repo) await ensureCloned(fromTarget.slug);
  }
  if (!parentName && !opts.root) {
    try {
      const cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
      const repoName = cwd.split("/").pop() || "";
      parentName = repoName.replace(/\.wt-.*$/, "").replace(/-oracle$/, "");
    } catch {
      throw new Error("could not detect parent oracle. Use --from <oracle> or --root");
    }
  }

  const budRepoName = `${name}-oracle`;
  const budRepoSlug = `${org}/${budRepoName}`;
  const budRepoPath = join(ghqRoot, org, budRepoName);

  if (opts.root) {
    console.log(`\n  \x1b[36m🌱 Root Bud\x1b[0m — ${name} (no parent lineage)\n`);
  } else {
    console.log(`\n  \x1b[36m🧬 Budding\x1b[0m — ${parentName} → ${name}\n`);
  }

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create repo: ${budRepoSlug}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would init ψ/ vault at: ${budRepoPath}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would generate CLAUDE.md`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create fleet config`);
    if (opts.seed && parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] --seed: would bulk soul-sync from ${parentName}`);
    } else if (parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] born blank — pull memory later: maw soul-sync ${parentName} --from`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] root oracle — no parent`);
    }
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would wake ${name}`);
    if (parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would add ${name} to ${parentName}'s sync_peers`);
    }
    console.log();
    return;
  }

  // 1. Create oracle repo
  await ensureBudRepo(budRepoSlug, budRepoPath, budRepoName, org);

  // 2-4.5. Initialize vault, CLAUDE.md, fleet config, birth note
  const psiDir = initVault(budRepoPath);
  generateClaudeMd(budRepoPath, name, parentName);
  const fleetFile = configureFleet(name, org, budRepoName, parentName);
  if (opts.note) writeBirthNote(psiDir, name, parentName, opts.note);

  // 5-8.5. Soul-sync, commit, sync peers, wake, split, copy
  await finalizeBud({
    name, parentName, org, budRepoName, budRepoPath, psiDir, ghqRoot, fleetFile,
    opts: { seed: opts.seed, issue: opts.issue, repo: opts.repo, split: opts.split, fast: opts.fast },
  });

  // Optional: drop birth signal into parent's ψ/
  if (opts.signalOnBirth && parentName) {
    const parentRepoPath = join(ghqRoot, org, `${parentName}-oracle`);
    writeSignal(parentRepoPath, name, {
      kind: "info",
      message: `bud born: ${name}`,
      context: { budRepoSlug: `${org}/${budRepoName}`, budRepoPath },
    });
    console.log(`  \x1b[36m⬡\x1b[0m signal dropped → ${parentName}'s ψ/memory/signals/`);
  }

  // Summary
  console.log(`\n  \x1b[32m${parentName ? "🧬 Bud" : "🌱 Root bud"} complete!\x1b[0m ${parentName ? `${parentName} → ${name}` : name}`);
  console.log(`  \x1b[90m  repo: ${budRepoSlug}`);
  console.log(`  \x1b[90m  fleet: ${fleetFile}`);
  console.log(`  \x1b[90m  sync_peers: [${parentName || ""}]`);
  if (!opts.fast) {
    console.log(`  \x1b[90m  run /awaken in the new oracle for full identity setup\x1b[0m`);
  }
  console.log();
}

// cmdBudTiny removed — --tiny deprecated, code preserved in deprecated/tiny-bud-209/
// Full buds with --blank default (alpha.38) are now as lightweight.
// Issue #209 closed. Nothing is Deleted — the code lives in deprecated/.
