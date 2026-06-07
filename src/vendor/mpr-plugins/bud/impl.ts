import { loadConfig } from "maw-js/config";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { parseWakeTarget, ensureCloned } from "maw-js/commands/shared/wake-target";
import { normalizeTarget } from "maw-js/core/matcher/normalize-target";
import { assertValidOracleName } from "maw-js/core/fleet/validate";
import { hostExec } from "maw-js/sdk";
import { ensureBudRepo } from "./bud-repo";
import { initVault, generateClaudeMd, configureFleet, writeBirthNote } from "./bud-init";
import { finalizeBud } from "./bud-wake";
import { writeSignal } from "maw-js/core/fleet/leaf";
import { validateNickname, writeNickname, setCachedNickname } from "maw-js/core/fleet/nicknames";
import { resolveOrg, formatOrgSource, type OrgResolution } from "./smart-default-org";
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
  /** Pretty display name — written to ψ/nickname at birth (#643 Phase 3). */
  nickname?: string;
  /** Create repo + local oracle skeleton only; stop before commit/push/wake/parent mutation. */
  scaffoldOnly?: boolean;
}

function oracleStemFromMaybeWorktreePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const repoName = parts.at(-2) === "agents" && parts.at(-3) ? parts.at(-3)! : (parts.at(-1) || "");
  return repoName.replace(/\.wt-.*$/, "").replace(/-oracle$/, "");
}

// TinyBudOpts removed — --tiny deprecated, code moved to deprecated/tiny-bud-209/
// See #209 for history. Full buds with --blank (alpha.38) are now as lightweight.

/**
 * maw bud <name> [--from <parent>] [--org <org>] [--repo org/repo] [--issue N] [--fast] [--dry-run]
 *
 * Yeast budding — any oracle can spawn a new oracle.
 *
 * Target org resolution (first wins) — see ./smart-default-org.ts for impl:
 *   1. --org <org>                    — per-invocation override (#235)
 *   2. MAW_BUD_OWNER env              — per-shell override
 *   3. config.githubOrg               — per-machine default from config
 *   4. fleet most-recent (FTS-tier)   — smart default from local fleet history
 *   5. gh api user (vector cold-start) — once per fresh machine when fleet empty
 *   6. "Soul-Brews-Studio"            — ultimate fallback
 *
 * The fleet→gh→default chain is the FTS+vector retrieval pattern (mirrored
 * from arra-oracle-v3): fast structural match first, slow authoritative
 * fallback when needed. Future Phase 3 upgrades to parallel-merge with a
 * confidence bonus — see follow-up issue.
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

  // Validate nickname early — fail fast before any repo work (#643 Phase 3).
  let nicknameValue = "";
  if (opts.nickname !== undefined) {
    const v = validateNickname(opts.nickname);
    if (!v.ok) throw new Error(v.error);
    nicknameValue = v.value;
  }

  const config = loadConfig();
  const reposRoot = join(getGhqRoot(), "github.com");

  // Resolve target org via the FTS+vector precedence chain (smart-default-org.ts).
  // Echo line happens just before `gh repo create` in bud-repo.ts so the user
  // can catch a wrong default before the destructive step.
  const orgResolution: OrgResolution = await resolveOrg({
    flag: opts.org,
    env: process.env.MAW_BUD_OWNER,
    config: config.githubOrg,
  });
  const org = orgResolution.org;

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
      parentName = oracleStemFromMaybeWorktreePath(cwd);
    } catch {
      throw new Error("could not detect parent oracle. Use --from <oracle> or --root");
    }
  }

  const budRepoName = `${name}-oracle`;
  const budRepoSlug = `${org}/${budRepoName}`;
  // Predicted path — may drift from ghq's actual landing dir when
  // the ghq root is stale (#630, #680). ensureBudRepo returns the authoritative
  // post-clone path; use that for all scaffolding below.
  const predictedRepoPath = join(reposRoot, org, budRepoName);

  const nickSuffix = nicknameValue ? ` (${nicknameValue})` : "";
  if (opts.root) {
    console.log(`\n  \x1b[36m🌱 Root Bud\x1b[0m — ${name}${nickSuffix} (no parent lineage)\n`);
  } else {
    console.log(`\n  \x1b[36m🧬 Budding\x1b[0m — ${parentName} → ${name}${nickSuffix}\n`);
  }

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create repo: ${budRepoSlug}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would init ψ/ vault at: ${predictedRepoPath}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would generate CLAUDE.md`);
    if (nicknameValue) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would write nickname: ${nicknameValue}`);
    }
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would create fleet config`);
    if (opts.seed && parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] --seed: would bulk soul-sync from ${parentName}`);
    } else if (parentName) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] born blank — pull memory later: maw soul-sync ${parentName} --from`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] root oracle — no parent`);
    }
    if (opts.scaffoldOnly) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] scaffold-only: would stop before git commit/push, wake, attach, parent sync_peers, and /awaken`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would wake ${name}`);
    }
    if (parentName && !opts.scaffoldOnly) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would add ${name} to ${parentName}'s sync_peers`);
    }
    console.log();
    return;
  }

  // Echo the resolved org + source BEFORE the destructive `gh repo create`
  // call, so the user can catch a wrong default (sticky-default trap) and
  // ^C before any network side-effects fire. All 3 v3 evaluators converged
  // on this as the essential mitigation against the recency-only ranking
  // failure mode (e.g., personal-fork side-quest after months in
  // Soul-Brews-Studio leaves fleet pointing at the wrong org until
  // explicitly bud back).
  console.log(`  \x1b[36m●\x1b[0m bud: creating ${budRepoSlug}`);
  console.log(`     \x1b[90msource: ${formatOrgSource(orgResolution)}\x1b[0m`);
  if (orgResolution.source === "fleet" || orgResolution.source === "gh" || orgResolution.source === "default") {
    console.log(`     \x1b[90moverride: --org <name> or MAW_BUD_OWNER=<name>\x1b[0m`);
  }

  // 1. Create oracle repo — returns the ACTUAL clone path per ghq (#630).
  const budRepoPath = await ensureBudRepo(budRepoSlug, predictedRepoPath, budRepoName, org);

  // 2-4.5. Initialize vault, CLAUDE.md, nickname, fleet config, birth note
  const psiDir = initVault(budRepoPath);
  generateClaudeMd(budRepoPath, name, parentName);
  if (nicknameValue) {
    // Authoritative on-disk write (staged by finalizeBud's `git add -A`),
    // then refresh the read-through cache so /info + peers pick it up immediately.
    writeNickname(budRepoPath, nicknameValue);
    setCachedNickname(name, nicknameValue);
    console.log(`  \x1b[32m✓\x1b[0m nickname set: \x1b[33m${nicknameValue}\x1b[0m`);
  }
  const fleetFile = configureFleet(name, org, budRepoName, parentName);
  if (opts.note) writeBirthNote(psiDir, name, parentName, opts.note);

  // #1551 — structure-only oracle creation. This intentionally stops after
  // the repo/skeleton/fleet scaffolding is present but before any lifecycle
  // side effects that make the oracle "alive": no initial commit/push, no
  // parent sync_peers mutation, no wake/split/attach, no /awaken trigger, and
  // no birth signal. Operators can inspect/edit the scaffold, then choose the
  // next lifecycle step explicitly.
  if (opts.scaffoldOnly) {
    console.log(`\n  \x1b[32m▧ Scaffold complete!\x1b[0m ${name}`);
    console.log(`  \x1b[90m  repo: ${budRepoSlug}`);
    console.log(`  \x1b[90m  path: ${budRepoPath}`);
    console.log(`  \x1b[90m  fleet: ${fleetFile}`);
    console.log(`  \x1b[90m  skipped: git commit/push, wake, attach, parent sync_peers, /awaken`);
    console.log(`  \x1b[90m  next: inspect files, then run maw wake ${name} or maw awaken ${name} when ready\x1b[0m`);
    console.log();
    return;
  }

  // 5-8.5. Soul-sync, commit, sync peers, wake, split, copy
  await finalizeBud({
    name, parentName, org, budRepoName, budRepoPath, psiDir, fleetFile,
    opts: { seed: opts.seed, issue: opts.issue, repo: opts.repo, split: opts.split, fast: opts.fast },
  });

  // Optional: drop birth signal into parent's ψ/
  if (opts.signalOnBirth && parentName) {
    const parentRepoPath = join(reposRoot, org, `${parentName}-oracle`);
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
