/**
 * maw restart — clean slate: kill stale views, update, stop fleet, wake all.
 *
 * Like restarting Claude Code but for the whole fleet.
 *
 * Steps:
 *   1. Kill all *-view sessions (stale grouped sessions)
 *   2. Update maw-js (optional, --no-update to skip)
 *   3. Stop fleet (maw stop)
 *   4. Wake fleet (maw wake all)
 */

import { listSessions } from "../ssh";
import { Tmux } from "../tmux";
import { cmdSleep, cmdWakeAll } from "./fleet";
import { execSync } from "child_process";

export async function cmdRestart(opts: { noUpdate?: boolean; ref?: string } = {}) {
  const tmux = new Tmux();
  console.log(`\n  \x1b[36m🔄 maw restart\x1b[0m\n`);

  // 1. Kill stale sessions (views, PTYs, bash leftovers)
  const sessions = await listSessions();
  const stale = sessions.filter(s =>
    s.name.endsWith("-view") || s.name.startsWith("maw-pty-") ||
    s.windows.every(w => w.name === "bash")
  );
  if (stale.length > 0) {
    console.log(`  \x1b[33m1. Cleaning ${stale.length} stale sessions...\x1b[0m`);
    for (const v of stale) {
      await tmux.killSession(v.name);
      console.log(`    \x1b[90m✗ ${v.name}\x1b[0m`);
    }
  } else {
    console.log(`  \x1b[90m1. No stale sessions\x1b[0m`);
  }

  // 2. Update maw-js
  if (!opts.noUpdate) {
    const ref = opts.ref || "main";
    console.log(`\n  \x1b[33m2. Updating maw-js (${ref})...\x1b[0m`);
    try {
      const pkg = require("../../package.json");
      const before = `v${pkg.version}`;
      try { execSync(`bun remove -g maw`, { stdio: "pipe" }); } catch {}
      execSync(`bun add -g github:${pkg.repository}#${ref}`, { stdio: "pipe" });
      let after = "";
      try { after = execSync(`maw --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch {}
      console.log(`    ${before} → ${after || "updated"}`);
    } catch (e: any) {
      console.log(`    \x1b[33m⚠ update failed: ${e.message?.slice(0, 80) || e}\x1b[0m`);
    }
  } else {
    console.log(`\n  \x1b[90m2. Update skipped (--no-update)\x1b[0m`);
  }

  // 3. Stop fleet
  console.log(`\n  \x1b[33m3. Stopping fleet...\x1b[0m`);
  await cmdSleep();

  // 4. Wake fleet
  console.log(`  \x1b[33m4. Waking fleet...\x1b[0m`);
  await cmdWakeAll();

  console.log(`\n  \x1b[32m✓ restart complete\x1b[0m\n`);
}
