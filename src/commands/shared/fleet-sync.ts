import { join } from "path";
import { existsSync, unlinkSync, symlinkSync, mkdirSync, readdirSync } from "fs";
import { tmux, FLEET_DIR } from "../../sdk";
import { getGhqRoot } from "../../config/ghq-root";
import { loadFleetEntries, getSessionNames } from "./fleet-load";

export async function cmdFleetSync() {
  const entries = loadFleetEntries();
  let added = 0;

  const runningSessions = await getSessionNames();
  // Derive repo paths from <ghqRoot>/github.com/ — strip that prefix to get org/repo.
  const reposRoot = join(getGhqRoot(), "github.com");

  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;

    try {
      // Use tmux.run for custom format (name:cwd) not available via listWindows
      const winOut = await tmux.run("list-windows", "-t", e.session.name, "-F", "#{window_name}:#{pane_current_path}");
      const runningWindows = winOut.trim().split("\n").filter(Boolean);
      const registeredNames = new Set(e.session.windows.map(w => w.name));

      for (const line of runningWindows) {
        const [winName, cwdPath] = line.split(":");
        if (!winName || registeredNames.has(winName)) continue;

        // Derive repo from cwd (strip reposRoot prefix)
        let repo = "";
        if (cwdPath?.startsWith(reposRoot + "/")) {
          repo = cwdPath.slice(reposRoot.length + 1);
        }

        e.session.windows.push({ name: winName, repo });
        console.log(`  \x1b[32m+\x1b[0m ${winName} → ${e.file}${repo ? ` (${repo})` : ""}`);
        added++;
      }
    } catch (err) { console.error(`  \x1b[33m⚠\x1b[0m failed to sync ${e.session.name}: ${err}`); }

    // Write updated config
    if (added > 0) {
      const filePath = join(FLEET_DIR, e.file);
      await Bun.write(filePath, JSON.stringify(e.session, null, 2) + "\n");
    }
  }

  if (added === 0) {
    console.log("\n  \x1b[32m✓ Fleet in sync.\x1b[0m No unregistered windows.\n");
  } else {
    console.log(`\n  \x1b[32m${added} window(s) added to fleet configs.\x1b[0m\n`);
  }
}

/**
 * Sync repo fleet/*.json configs to FLEET_DIR (~/.config/maw/fleet/).
 * Symlinks each config so edits in either location stay in sync.
 */
export async function cmdFleetSyncConfigs() {
  const repoFleetDir = join(import.meta.dir, "..", "..", "fleet");

  if (!existsSync(repoFleetDir)) {
    console.error(`  \x1b[31m✗\x1b[0m No fleet/ directory found in repo`);
    process.exit(1);
  }

  const files = readdirSync(repoFleetDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("  \x1b[90mNo fleet configs to sync.\x1b[0m");
    return;
  }

  // Ensure FLEET_DIR exists
  mkdirSync(FLEET_DIR, { recursive: true });

  let synced = 0;
  for (const file of files) {
    const src = join(repoFleetDir, file);
    const dest = join(FLEET_DIR, file);

    // Remove existing file/symlink before creating new symlink
    try { unlinkSync(dest); } catch { /* expected: file may not exist */ }
    symlinkSync(src, dest);
    synced++;
  }

  console.log(`  \x1b[32m✓ ${synced} fleet config(s) synced\x1b[0m → ${FLEET_DIR}`);
}
