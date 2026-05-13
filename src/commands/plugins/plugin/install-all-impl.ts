/**
 * maw plugin install --all (#1277 companion)
 *
 * Batch-reinstall every plugin in plugins.lock by re-dispatching the
 * existing install flow for each entry's `source`. Useful after a source
 * dir rename or fresh clone.
 *
 * Why a separate file? Keeps install-impl.ts focused on single-source
 * dispatch (already 130 LoC). The batch loop is a thin shell that just
 * calls back into cmdPluginInstall — no duplicated logic.
 *
 * Behavior per source type:
 *   • link:<abs-path>  → re-link (cmdPluginInstall handles the directory)
 *   • <url>            → download + extract + verify
 *   • <github-ref>     → tarball download
 *   • <local-tarball>  → extract + verify  (only if path still exists)
 *   • bare name        → registry resolve  (rare in lock — sources are
 *                                            usually concrete by the time
 *                                            we record them)
 *
 * --dry-run prints what would happen without touching the network or FS.
 * --force is propagated to each install (so existing dirs are replaced).
 *
 * Failures are isolated: one bad plugin doesn't stop the rest. We collect
 * + report at the end and exit non-zero iff anything failed.
 */

import { readLock } from "./lock";

export interface InstallAllOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface InstallAllResult {
  total: number;
  installed: number;
  skipped: number;
  failed: { name: string; reason: string }[];
}

export async function cmdPluginInstallAll(opts: InstallAllOptions = {}): Promise<InstallAllResult> {
  const lock = readLock();
  const entries = Object.entries(lock.plugins);
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;

  if (entries.length === 0) {
    console.log("plugins.lock is empty — nothing to install.");
    return { total: 0, installed: 0, skipped: 0, failed: [] };
  }

  console.log(`install --all: ${entries.length} entries in plugins.lock${dryRun ? " (dry-run)" : ""}`);

  const failed: { name: string; reason: string }[] = [];
  let installed = 0;
  let skipped = 0;

  for (const [name, entry] of entries) {
    const source = entry.source ?? "";

    // For `link:` sources, the install argument is the absolute path
    // (the directory). detectMode() in install-source-detect.ts treats
    // dir paths as `--link` installs implicitly when you pass a dir.
    let installArg: string;
    if (source.startsWith("link:")) {
      installArg = source.slice("link:".length);
    } else {
      installArg = source;
    }

    if (!installArg) {
      console.log(`  - ${name}: no source recorded — skipping`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  would install: ${name} ← ${source}`);
      installed++;
      continue;
    }

    console.log(`  → ${name} ← ${source}`);
    try {
      const { cmdPluginInstall } = await import("./install-impl");
      const args: string[] = [installArg];
      if (force) args.push("--force");
      // For link: sources, mirror the original --link flag so the install
      // path takes the symlink branch (not a real copy).
      if (source.startsWith("link:")) args.push("--link");
      await cmdPluginInstall(args);
      installed++;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${name}: ${reason.split("\n")[0]}`);
      failed.push({ name, reason });
    }
  }

  const verb = dryRun ? "install --all (dry-run)" : "install --all";
  console.log(
    `${verb}: ${installed}/${entries.length} ${dryRun ? "would install" : "installed"}` +
    (skipped ? `, ${skipped} skipped` : "") +
    (failed.length ? `, ${failed.length} failed` : ""),
  );

  if (failed.length > 0 && !dryRun) {
    // Non-fatal exit signal — bubble up so the dispatcher can mark ok:false.
    throw new Error(`install --all: ${failed.length} of ${entries.length} failed`);
  }

  return { total: entries.length, installed, skipped, failed };
}
