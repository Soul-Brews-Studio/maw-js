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

import { listSessions } from "../../../sdk";
import { Tmux } from "../../../sdk";
import { cmdSleep, cmdWakeAll } from "../../shared/fleet";
import { execSync } from "child_process";
import { ghqFindSync } from "../../../core/ghq";

const HELP_TEXT = [
  "usage: maw restart [--no-update] [--ref <git-ref>]",
  "",
  "  Restart the whole maw fleet:",
  "    1. kill stale *-view sessions",
  "    2. update maw-js (unless --no-update)",
  "    3. stop fleet (maw stop)",
  "    4. wake fleet (maw wake all)",
  "",
  "  Flags:",
  "    --no-update   skip the git pull + rebuild step",
  "    --ref <ref>   update to a specific ref (branch/tag/sha) instead of default",
  "    --help, -h    show this message and exit (no side effects)",
].join("\n");

export async function cmdRestart(opts: { noUpdate?: boolean; ref?: string; help?: boolean } = {}) {
  // #349 — defense-in-depth guard. The index.ts handler should catch --help
  // first, but a broken dispatch could call cmdRestart directly with opts=defaults.
  // Check process.argv too since we're the destructive core.
  if (opts.help || process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
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
      const pkg = require("../../../../package.json");
      const before = `v${pkg.version}`;
      // Atomic install sequence — try install over existing FIRST so that a
      // transient failure (network, auth, bun version) cannot leave the user
      // with an uninstalled maw. `bun remove` only runs as a fallback when
      // the initial install fails. Mirrors the alpha.132 fix in cmd-update.ts
      // (regression #507 — this site was missed in the original sweep).
      const tryInstall = (): boolean => {
        try {
          execSync(`bun add -g github:${pkg.repository}#${ref}`, { stdio: "pipe" });
          return true;
        } catch { return false; }
      };
      if (!tryInstall()) {
        console.log(`    \x1b[33m⚠ first install attempt failed — clearing stale global refs and retrying\x1b[0m`);
        try { execSync(`bun remove -g maw`, { stdio: "pipe" }); } catch {}
        if (!tryInstall()) {
          console.log(`    \x1b[31m✗ update failed — manual recovery: bun add -g github:${pkg.repository}#alpha\x1b[0m`);
          return;
        }
      }
      let after = "";
      try { after = execSync(`maw --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch {}
      console.log(`    ${before} → ${after || "updated"}`);
      // Link SDK for plugins
      try {
        const mawDir = ghqFindSync("/Soul-Brews-Studio/maw-js");
        if (mawDir) {
          execSync(`cd ${mawDir} && bun link`, { stdio: "pipe" });
          const oDir = require("os").homedir() + "/.oracle";
          require("fs").mkdirSync(oDir, { recursive: true });
          if (!require("fs").existsSync(oDir + "/package.json")) {
            require("fs").writeFileSync(oDir + "/package.json", '{"name":"oracle-plugins","private":true}\n');
          }
          execSync(`cd ${oDir} && bun link maw`, { stdio: "pipe" });
          console.log(`    🔗 SDK linked`);
        }
      } catch { /* non-fatal */ }
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
