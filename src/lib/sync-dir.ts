/**
 * sync-dir.ts — vendored "copy new files only" helper (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors the `syncDir` function in
 * `src/commands/plugins/soul-sync/sync-helpers.ts` so that
 * `src/commands/plugins/bud/bud-wake.ts` (and any other src/core / src/api /
 * src/lib consumer) can copy ψ subtrees without reaching across the plugin
 * boundary into the soul-sync plugin.
 *
 * After the follow-up "prune" PR removes the soul-sync plugin's source, this
 * vendored copy is the canonical location for the dest-biased copy primitive.
 *
 * Semantics: dest-biased ("Nothing is Deleted") — pre-existing target files
 * are preserved, missing source returns 0, unreadable entries are skipped
 * silently. Returns the number of files copied.
 */
import { existsSync, readdirSync, copyFileSync, mkdirSync, Dirent } from "fs";
import { join } from "path";

/**
 * Copy new files from src dir to dst dir (skip existing). Returns count copied.
 * Recursive walk; missing dst dirs are created on-demand. Errors during
 * directory listing or per-file copy are swallowed — same forgiving stance
 * as the soul-sync plugin's original.
 */
export function syncDir(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) return 0;
  let count = 0;

  function walk(src: string, dst: string) {
    let entries: Dirent[];
    try { entries = readdirSync(src, { withFileTypes: true }) as Dirent[]; }
    catch { return; }

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (!existsSync(dstPath)) {
        try {
          mkdirSync(dst, { recursive: true });
          copyFileSync(srcPath, dstPath);
          count++;
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(srcDir, dstDir);
  return count;
}
