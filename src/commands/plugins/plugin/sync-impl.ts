/**
 * maw plugin sync (#1277)
 *
 * Reconcile ~/.maw/plugins/ against plugins.lock. Non-destructive by default —
 * only recreates missing/broken symlinks for `link:` sources. For tarball /
 * URL / GitHub sources, prints an actionable hint pointing at `maw plugin
 * install <name>` (the safe, network-aware path).
 *
 * Why a separate command? Auto-cleanup at plugin-bootstrap.ts:99 and
 * cmd-update.ts:337 silently removes broken symlinks without recovery. If
 * the source dir holding maw-js is renamed (e.g. `~/Code` → `/opt/Code`)
 * every linked plugin evaporates. plugins.lock retains enough metadata
 * (source: "link:/abs/path") to recreate the link iff the target still
 * exists somewhere on disk.
 *
 * Design constraints:
 *   • NEVER delete anything. Only `symlinkSync(target, dest)` for missing.
 *   • `--dry-run` prints the would-be repairs without touching the FS.
 *   • Registry/tarball sources don't auto-reinstall here — that's a
 *     network operation; surface as a hint instead. (`install --all` is
 *     the batch reinstall path; see install-impl.ts.)
 */

import { existsSync, lstatSync, realpathSync, symlinkSync } from "fs";
import { join } from "path";
import { readLock } from "./lock";
import { installRoot } from "./install-source-detect";

export interface SyncOptions {
  dryRun?: boolean;
}

export interface SyncResult {
  ok: number;
  fixed: number;
  broken: number;
  missing: number;
}

/**
 * Read plugins.lock, walk every entry, recreate broken symlinks for
 * `link:`-sourced plugins. Returns counts so callers / tests can assert.
 */
export async function cmdPluginSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const lock = readLock();
  const pluginDir = installRoot();
  const dryRun = !!opts.dryRun;

  let ok = 0, fixed = 0, broken = 0, missing = 0;
  const entries = Object.entries(lock.plugins);

  if (entries.length === 0) {
    console.log("plugins.lock is empty — nothing to sync.");
    console.log("Sync: 0 ok, 0 fixed, 0 broken, 0 missing");
    return { ok: 0, fixed: 0, broken: 0, missing: 0 };
  }

  for (const [name, entry] of entries) {
    const symlink = join(pluginDir, name);

    // Distinguish three states:
    //   1. link present + target reachable          → ok
    //   2. link absent OR present-but-target-gone   → try to repair
    //
    // We use lstat (not stat) so we don't follow the symlink — a dangling
    // symlink reports as a symlink, not as ENOENT.
    let linkPresent = false;
    let targetReachable = false;
    try {
      lstatSync(symlink);
      linkPresent = true;
      try {
        const real = realpathSync(symlink);
        targetReachable = existsSync(real);
      } catch {
        // realpath can throw on dangling symlinks → target unreachable.
        targetReachable = false;
      }
    } catch {
      linkPresent = false;
    }

    if (linkPresent && targetReachable) {
      ok++;
      continue;
    }

    // Need repair. Behavior depends on source type.
    const source = entry.source ?? "";

    if (source.startsWith("link:")) {
      const target = source.slice("link:".length);
      if (!existsSync(target)) {
        console.log(`  ✗ ${name}: link target missing — ${target}`);
        broken++;
        continue;
      }
      if (dryRun) {
        console.log(`  would fix: ${name} → ${target}`);
      } else {
        // Non-destructive: only create when the link is absent. If a
        // dangling link is in the way, surface it instead of silently
        // unlinking — preserves the "nothing is deleted" principle.
        if (linkPresent) {
          console.log(`  ✗ ${name}: link present but dangling (target ${target} ok) — re-run 'maw plugin install --link ${target}' to refresh`);
          broken++;
          continue;
        }
        symlinkSync(target, symlink);
        console.log(`  ✓ fixed: ${name} → ${target}`);
      }
      fixed++;
    } else {
      // Registry tarball / URL / GitHub source. We can't safely re-fetch
      // here — that's a network gesture and the user may want to choose.
      // Surface the actionable hint.
      const sourceLabel = source || "(no source recorded)";
      console.log(`  ! ${name}: missing/broken — source=${sourceLabel}`);
      console.log(`      run: maw plugin install ${name}`);
      missing++;
    }
  }

  const verb = dryRun ? "Sync (dry-run)" : "Sync";
  console.log(`${verb}: ${ok} ok, ${fixed} fixed, ${broken} broken, ${missing} missing`);
  if (missing > 0 && !dryRun) {
    console.log(`Tip: 'maw plugin install --all' will reinstall every entry in plugins.lock.`);
  }
  return { ok, fixed, broken, missing };
}
