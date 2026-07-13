/**
 * crew-skills sync — install the canonical /crew + /warroom skills and the
 * worker Stop hook into a home `.claude` tree.
 *
 * One canonical copy lives in this plugin's assets/. Installing globally into
 * ~/.claude/skills + ~/.claude/hooks means every oracle picks up /crew +
 * /warroom (and the worker Stop hook) from the maw upgrade — no per-oracle
 * copy to drift. The worker settings + hook use $HOME-absolute paths so the
 * spawn contract works from any oracle's cwd.
 *
 * Pure node:fs so the standalone boundary stays trivial to assert.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * kobo-196 — the SessionStart:clear command that auto-reseats a pane after
 * /clear. $HOME-absolute so it resolves the globally-installed seat-resume.sh
 * from any oracle's cwd. seat-resume.sh self-gates to warroom repos, so a plain
 * (non-warroom) pane sees nothing.
 *
 * Wired into two SCOPED places (never the user's personal ~/.claude/settings.json):
 *  - the oracle REPO's .claude/settings.json → lead/comm/conductor panes, which
 *    run from the repo dir and inherit its settings (where eq3 proved it);
 *  - crew-worker-settings.json (the asset workers spawn with --settings) → worker panes.
 */
const SEAT_RESUME_COMMAND = "bash $HOME/.claude/hooks/seat-resume.sh";
const SEAT_RESUME_MATCHER = "startup|resume|clear"; // kobo-268: auto-seat on every (re)start, not clear-only

export interface SyncItem {
  /** path relative to the plugin assets/ dir */
  src: string;
  /** path relative to <home>/.claude */
  dest: string;
  /** chmod 0o755 after write (shell hooks) */
  exec?: boolean;
}

/** Canonical asset → global .claude layout. */
export const SYNC_ITEMS: SyncItem[] = [
  { src: "skills/crew/SKILL.md", dest: "skills/crew/SKILL.md" },
  { src: "skills/warroom/SKILL.md", dest: "skills/warroom/SKILL.md" },
  { src: "skills/head/SKILL.md", dest: "skills/head/SKILL.md" }, // kobo-299 — /head 3-tier strategic cell (additive; /warroom stays until cutover kobo-303)
  { src: "hooks/crew-worker-stop.sh", dest: "hooks/crew-worker-stop.sh", exec: true },
  { src: "hooks/maw-card-gate.sh", dest: "hooks/maw-card-gate.sh", exec: true }, // kobo-174 — lead card-create gate (dormant until an oracle opts in via .maw/card-gate.json, kobo-200)
  { src: "hooks/seat-resume.sh", dest: "hooks/seat-resume.sh", exec: true }, // kobo-196 — auto-seat on SessionStart:clear (self-gates to warroom repos; wired into the oracle REPO's settings by ensureSeatResumeHook, never the user's global ~/.claude)
  { src: "card-gate.sample.json", dest: "card-gate.sample.json" }, // kobo-200 — dormant sample; adopter copies to <repo>/.maw/card-gate.json (hook reads .maw/, NOT this path → never auto-activates)
  { src: "crew-worker-settings.json", dest: "crew-worker-settings.json" },
];

export interface SyncOptions {
  /** target home (default: os.homedir()) */
  home?: string;
  /** source assets dir (default: ./assets next to this module) */
  assetsDir?: string;
  /** report what would change without writing */
  dryRun?: boolean;
  /** rewrite even when content is byte-identical */
  force?: boolean;
  /**
   * kobo-196 — where to wire the SessionStart:clear seat-resume hook. The oracle
   * REPO dir (default process.cwd()); its .claude/settings.json is scoped to this
   * repo, so we never touch the user's personal ~/.claude/settings.json.
   */
  repoDir?: string;
}

export interface SyncResult {
  home: string;
  claudeDir: string;
  /** dest paths (relative to .claude) that were written / would be written */
  installed: string[];
  /** dest paths skipped because already up-to-date */
  skipped: string[];
  /** true when the SessionStart:clear seat-resume hook was added to settings.json */
  seatHookWired: boolean;
  dryRun: boolean;
}

/**
 * Ensure the given `.claude/settings.json` carries a SessionStart:clear hook
 * that runs seat-resume.sh (kobo-196). The caller passes the oracle REPO's
 * .claude dir (scoped-both), never the user's personal ~/.claude — mutating a
 * global settings would fire the hook on every /clear in every repo (worker.3
 * reject). Idempotent + non-destructive: reads the existing settings, adds the
 * hook only when absent, preserves every other key and hook. Mirrors the merge
 * shape in core/worklog/hook-setup.ts.
 *
 * Returns true when it added (or, in dryRun, would add) the hook.
 */
export function ensureSeatResumeHook(
  claudeDir: string,
  opts: { dryRun?: boolean } = {},
): boolean {
  const settingsPath = join(claudeDir, "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const entries = settings.hooks.SessionStart as any[];

  // kobo-268: fire on startup|resume|clear (not clear-only) so a pane auto-seats on every
  // (re)start, not just after /clear. Find an existing seat-resume entry by COMMAND (any
  // matcher) so a re-sync UPGRADES an old clear-only install in place instead of duplicating.
  const existing = entries.find(e =>
    Array.isArray(e?.hooks) && e.hooks.some((hk: any) => hk?.command === SEAT_RESUME_COMMAND));
  if (existing) {
    if (existing.matcher === SEAT_RESUME_MATCHER) return false; // already current
    if (opts.dryRun) return true;
    existing.matcher = SEAT_RESUME_MATCHER; // upgrade clear-only → startup|resume|clear
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  }

  entries.push({ matcher: SEAT_RESUME_MATCHER, hooks: [{ type: "command", command: SEAT_RESUME_COMMAND }] });
  if (opts.dryRun) return true;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

function defaultAssetsDir(): string {
  return join(import.meta.dir, "assets");
}

function sameContent(srcPath: string, destPath: string): boolean {
  if (!existsSync(destPath)) return false;
  try {
    return readFileSync(srcPath, "utf8") === readFileSync(destPath, "utf8");
  } catch {
    return false;
  }
}

export function syncCrewSkills(options: SyncOptions = {}): SyncResult {
  const home = options.home ?? homedir();
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const claudeDir = join(home, ".claude");
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const item of SYNC_ITEMS) {
    const srcPath = join(assetsDir, item.src);
    const destPath = join(claudeDir, item.dest);

    if (!options.force && sameContent(srcPath, destPath)) {
      skipped.push(item.dest);
      continue;
    }
    installed.push(item.dest);
    if (options.dryRun) continue;

    mkdirSync(dirname(destPath), { recursive: true });
    cpSync(srcPath, destPath);
    if (item.exec) chmodSync(destPath, 0o755);
  }

  // kobo-196 — wire the SessionStart:clear seat-resume hook into the oracle
  // REPO's .claude/settings.json (scoped-both), so lead/comm/conductor panes
  // (which run from the repo dir) auto-reseat after /clear. Worker panes get it
  // via crew-worker-settings.json. NEVER the user's global ~/.claude/settings.json.
  const repoDir = options.repoDir ?? process.cwd();
  const seatHookWired = ensureSeatResumeHook(join(repoDir, ".claude"), { dryRun: options.dryRun });

  return { home, claudeDir, installed, skipped, seatHookWired, dryRun: !!options.dryRun };
}

export function formatSyncResult(result: SyncResult): string {
  const verb = result.dryRun ? "would install" : "installed";
  const lines = [
    `${verb} crew skills → ${result.claudeDir}`,
    `  /crew + /warroom + /head skills, worker Stop hook, worker settings`,
    `  ${verb}: ${result.installed.length} · up-to-date: ${result.skipped.length}`,
  ];
  for (const dest of result.installed) lines.push(`  + ${dest}`);
  if (result.seatHookWired) {
    lines.push(`  + settings.json SessionStart:clear → seat-resume.sh (auto-seat)`);
  }
  return lines.join("\n");
}
