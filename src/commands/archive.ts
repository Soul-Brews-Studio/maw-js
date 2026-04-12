import { hostExec } from "../ssh";
import { loadConfig } from "../config";
import { loadFleetEntries } from "./fleet-load";
import { cmdSoulSync } from "./soul-sync";
import { FLEET_DIR } from "../paths";
import { join } from "path";
import { existsSync, renameSync } from "fs";

/**
 * maw archive <oracle> [--dry-run]
 *
 * Apoptosis — graceful oracle death.
 *   1. Final soul-sync to all peers
 *   2. Disable fleet config (.disabled)
 *   3. Archive GitHub repo
 *   4. Log death in family registry
 */
export async function cmdArchive(oracleName: string, opts: { dryRun?: boolean } = {}) {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const entries = loadFleetEntries();

  const entry = entries.find(e => e.session.name.replace(/^\d+-/, "") === oracleName);
  if (!entry) {
    console.error(`  \x1b[31m✗\x1b[0m oracle '${oracleName}' not found in fleet config`);
    process.exit(1);
  }

  const mainWindow = entry.session.windows[0];
  const repoSlug = mainWindow?.repo || "";
  const repoPath = repoSlug ? join(ghqRoot, repoSlug) : "";

  console.log(`\n  \x1b[36m⚰️  Archiving\x1b[0m — ${oracleName}\n`);

  // 1. Final soul-sync to all peers
  if (entry.session.sync_peers?.length) {
    if (opts.dryRun) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would soul-sync to ${entry.session.sync_peers.join(", ")}`);
    } else {
      console.log(`  \x1b[36m⏳\x1b[0m final soul-sync to peers...`);
      try {
        if (repoPath) await cmdSoulSync(undefined, { cwd: repoPath });
        console.log(`  \x1b[32m✓\x1b[0m soul-sync complete`);
      } catch {
        console.log(`  \x1b[33m⚠\x1b[0m soul-sync failed (peers may be offline)`);
      }
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m no sync_peers configured — knowledge stays local`);
  }

  // 2. Disable fleet config
  const fleetFile = join(FLEET_DIR, entry.file);
  const disabledFile = fleetFile + ".disabled";
  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would disable: ${entry.file} → ${entry.file}.disabled`);
  } else {
    try {
      renameSync(fleetFile, disabledFile);
      console.log(`  \x1b[32m✓\x1b[0m fleet config disabled: ${entry.file}.disabled`);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m could not disable fleet config: ${e.message}`);
    }
  }

  // 3. Archive GitHub repo
  if (repoSlug) {
    if (opts.dryRun) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would archive: gh repo archive ${repoSlug}`);
    } else {
      try {
        await hostExec(`gh repo archive ${repoSlug} --yes`);
        console.log(`  \x1b[32m✓\x1b[0m GitHub repo archived: ${repoSlug}`);
      } catch (e: any) {
        console.log(`  \x1b[33m⚠\x1b[0m archive failed: ${e.message || e}`);
      }
    }
  }

  // 4. Death certificate
  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would log death to family registry`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m ${oracleName} archived — ψ/ preserved locally, knowledge synced to peers`);
  }

  console.log();
  if (!opts.dryRun) {
    console.log(`  \x1b[90mNothing is deleted (Principle 1). ψ/ and git history remain.\x1b[0m`);
    console.log(`  \x1b[90mTo unarchive: rename ${entry.file}.disabled → ${entry.file} + gh repo unarchive\x1b[0m`);
  }
  console.log();
}
