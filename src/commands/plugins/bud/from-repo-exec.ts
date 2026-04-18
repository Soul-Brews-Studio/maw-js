/**
 * Executor for `maw bud --from-repo <local-path> --stem <stem>` (#588).
 *
 * Scope: LOCAL-PATH only. URL clone / --pr / --force / fleet wiring deferred.
 *
 * Design: docs/bud/from-repo-design.md, docs/bud/from-repo-impl.md
 *
 * Write order is fail-before-mutate:
 *   1. ψ/ dir tree
 *   2. .claude/settings.local.json (if absent)
 *   3. CLAUDE.md (append under marker if exists; full write if absent)
 *
 * No rollback on mid-run failure — partial state is preserved so the caller
 * can inspect it. See `docs/bud/from-repo-impl.md` section (b).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { FromRepoOpts, InjectionPlan } from "./types";

/** Matches the dir list in planFromRepoInjection — same 8 subpaths. */
const PSI_SUBDIRS = [
  "memory/learnings",
  "memory/retrospectives",
  "memory/traces",
  "memory/resonance",
  "memory/collaborations",
  "inbox",
  "outbox",
  "plans",
];

/** HTML-comment fence prefix. Scoped by stem so re-seed under a different stem still appends. */
export function oracleMarkerBegin(stem: string): string {
  return `<!-- oracle-scaffold: begin stem=${stem} -->`;
}
export function oracleMarkerEnd(stem: string): string {
  return `<!-- oracle-scaffold: end stem=${stem} -->`;
}

/** Full CLAUDE.md template — used when target repo has no CLAUDE.md. */
function fullClaudeMd(stem: string, today: string, parent?: string): string {
  const lineageHeader = parent
    ? `> Budded from **${parent}** on ${today} via \`maw bud --from-repo\``
    : `> Oracle scaffolding injected on ${today} via \`maw bud --from-repo\``;
  const originLine = parent
    ? `- **Budded from**: ${parent}\n<!-- oracle-lineage: parent=${parent} -->`
    : `- **Origin**: injected into existing repo (not budded from a parent)`;
  return `# ${stem}-oracle

${lineageHeader}

## Identity
- **Name**: ${stem}
- **Purpose**: (to be defined by /awaken)
${originLine}

## Principles (inherited from Oracle)
1. Nothing is Deleted
2. Patterns Over Intentions
3. External Brain, Not Command
4. Curiosity Creates Existence
5. Form and Formless

## Rule 6: Oracle Never Pretends to Be Human

Run \`/awaken\` for the full identity setup ceremony.
`;
}

/** The appended block — fenced with markers so re-runs are idempotent. */
function appendBlock(stem: string, today: string, parent?: string): string {
  const lineageBullet = parent
    ? `\n- **Budded from**: ${parent}\n<!-- oracle-lineage: parent=${parent} -->`
    : "";
  return `\n${oracleMarkerBegin(stem)}
## Oracle scaffolding

> Budded into this repo on ${today} via \`maw bud --from-repo --stem ${stem}\`

- **Oracle stem**: ${stem}${lineageBullet}
- **Rule 6**: Oracle Never Pretends to Be Human — sign federation messages as \`[<host>:${stem}]\`
- Run \`/awaken\` for the full identity setup ceremony.
${oracleMarkerEnd(stem)}
`;
}

/** Report one line per action. Caller passes a logger (defaults to console.log). */
type Log = (msg: string) => void;
const defaultLog: Log = (m) => console.log(m);

/** mkdir ψ/ tree. Recursive + idempotent. */
function writeVault(target: string, log: Log): void {
  const psiDir = join(target, "ψ");
  for (const d of PSI_SUBDIRS) {
    mkdirSync(join(psiDir, d), { recursive: true });
  }
  log(`  \x1b[32m✓\x1b[0m ψ/ vault initialized (${PSI_SUBDIRS.length} dirs)`);
}

/** Write .claude/settings.local.json only if absent. */
function writeSettings(target: string, log: Log): void {
  const claudeDir = join(target, ".claude");
  const settings = join(claudeDir, "settings.local.json");
  if (existsSync(settings)) {
    log(`  \x1b[90m○\x1b[0m .claude/settings.local.json exists — untouched`);
    return;
  }
  mkdirSync(claudeDir, { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  writeFileSync(settings, "{}\n");
  log(`  \x1b[32m✓\x1b[0m .claude/settings.local.json written`);
}

/** Write or append CLAUDE.md. Idempotent via HTML-comment marker. */
function writeClaudeMd(target: string, stem: string, today: string, log: Log, parent?: string): void {
  const claudePath = join(target, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
    writeFileSync(claudePath, fullClaudeMd(stem, today, parent));
    log(`  \x1b[32m✓\x1b[0m CLAUDE.md written (full template)${parent ? ` — lineage: ${parent}` : ""}`);
    return;
  }
  const existing = readFileSync(claudePath, "utf-8");
  if (existing.includes(oracleMarkerBegin(stem))) {
    log(`  \x1b[90m○\x1b[0m CLAUDE.md already has oracle block for stem=${stem} — skip`);
    return;
  }
  const sep = existing.endsWith("\n") ? "" : "\n";
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  writeFileSync(claudePath, existing + sep + appendBlock(stem, today, parent));
  log(`  \x1b[32m✓\x1b[0m CLAUDE.md appended oracle-scaffold block for stem=${stem}${parent ? ` — lineage: ${parent}` : ""}`);
}

/**
 * Append `ψ/` to .gitignore unless --track-vault. Idempotent — skip if any
 * non-comment line already matches `^ψ/?$`.
 */
function writeGitignore(target: string, log: Log): void {
  const path = join(target, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.split("\n").map(l => l.trim());
  if (lines.some(l => l === "ψ" || l === "ψ/")) {
    log(`  \x1b[90m○\x1b[0m .gitignore already ignores ψ/ — skip`);
    return;
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  writeFileSync(path, existing + sep + "ψ/\n");
  log(`  \x1b[32m✓\x1b[0m .gitignore now ignores ψ/ (pass --track-vault to keep tracked)`);
}

/**
 * Apply the injection plan. Throws on blockers; writes otherwise.
 * Safe to call on clean or partially-injected repos (idempotent on CLAUDE.md).
 */
export async function applyFromRepoInjection(
  plan: InjectionPlan,
  opts: FromRepoOpts,
  log: Log = defaultLog,
): Promise<void> {
  if (plan.blockers.length > 0) {
    throw new Error(`cannot apply — plan has ${plan.blockers.length} blocker(s): ${plan.blockers.join("; ")}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  log(`\n  \x1b[36m🌱 injecting oracle scaffolding\x1b[0m — ${opts.stem} → ${plan.target}\n`);
  writeVault(plan.target, log);
  writeSettings(plan.target, log);
  writeClaudeMd(plan.target, opts.stem, today, log, opts.from);
  if (!opts.trackVault) writeGitignore(plan.target, log);
  log(`\n  \x1b[32m✓ done\x1b[0m — run \`maw wake ${opts.stem}\` to start a session\n`);
}
