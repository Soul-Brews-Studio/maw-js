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

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  { src: "hooks/crew-worker-stop.sh", dest: "hooks/crew-worker-stop.sh", exec: true },
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
}

export interface SyncResult {
  home: string;
  claudeDir: string;
  /** dest paths (relative to .claude) that were written / would be written */
  installed: string[];
  /** dest paths skipped because already up-to-date */
  skipped: string[];
  dryRun: boolean;
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

  return { home, claudeDir, installed, skipped, dryRun: !!options.dryRun };
}

export function formatSyncResult(result: SyncResult): string {
  const verb = result.dryRun ? "would install" : "installed";
  const lines = [
    `${verb} crew skills → ${result.claudeDir}`,
    `  /crew + /warroom skills, worker Stop hook, worker settings`,
    `  ${verb}: ${result.installed.length} · up-to-date: ${result.skipped.length}`,
  ];
  for (const dest of result.installed) lines.push(`  + ${dest}`);
  return lines.join("\n");
}
