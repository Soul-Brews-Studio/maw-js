import { cmdFleetLs, cmdFleetRenumber, cmdFleetValidate, cmdFleetSync, cmdFleetSyncConfigs } from "../commands/fleet";
import { cmdFleetInit, cmdFleetInitAgents } from "../commands/fleet-init";
import { cmdPulseAdd, cmdPulseLs } from "../commands/pulse";
import { cmdOverview } from "../commands/overview";
import { cmdMegaStatus, cmdMegaStop } from "../commands/mega";
import { cmdFederationStatus } from "../commands/federation";
import { cmdFederationSync } from "../commands/federation-sync";
import { cmdReunion } from "../commands/reunion";
import { cmdSoulSync } from "../commands/soul-sync";
import { cmdFleetHealth } from "../commands/fleet-health";
import { cmdFleetDoctor } from "../commands/fleet-doctor";
import { cmdFleetConsolidate } from "../commands/fleet-consolidate";
import { cmdArchive } from "../commands/archive";
import { cmdFind } from "../commands/find";

export async function routeFleet(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "fleet") {
    const sub = args[1];
    if (sub === "init") {
      if (args.includes("--agents")) {
        await cmdFleetInitAgents({ dryRun: args.includes("--dry-run") });
      } else {
        await cmdFleetInit();
      }
    } else if (sub === "ls") {
      await cmdFleetLs();
    } else if (sub === "renumber") {
      await cmdFleetRenumber();
    } else if (sub === "validate") {
      await cmdFleetValidate();
    } else if (sub === "health") {
      await cmdFleetHealth();
    } else if (sub === "doctor" || sub === "dr") {
      await cmdFleetDoctor({ fix: args.includes("--fix"), json: args.includes("--json") });
    } else if (sub === "consolidate") {
      await cmdFleetConsolidate({ dryRun: args.includes("--dry-run"), remove: args.includes("--remove") });
    } else if (sub === "sync") {
      await cmdFleetSyncConfigs();
    } else if (sub === "sync-windows" || sub === "syncwin") {
      await cmdFleetSync();
    } else if (sub === "snapshots" || sub === "snapshot-ls") {
      const { listSnapshots } = await import("../snapshot");
      const snaps = listSnapshots();
      if (snaps.length === 0) { console.log("no snapshots yet"); process.exit(0); }
      console.log(`\x1b[36m📸 ${snaps.length} snapshots\x1b[0m\n`);
      for (const s of snaps) {
        const d = new Date(s.timestamp);
        const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
        console.log(`  ${s.file.replace(".json", "")}  ${local}  \x1b[90m${s.trigger}\x1b[0m  ${s.sessionCount} sessions, ${s.windowCount} windows`);
      }
    } else if (sub === "restore") {
      const { loadSnapshot, latestSnapshot } = await import("../snapshot");
      const snap = args[2] ? loadSnapshot(args[2]) : latestSnapshot();
      if (!snap) { console.error("no snapshot found"); process.exit(1); }
      const d = new Date(snap.timestamp);
      const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
      console.log(`\x1b[36m📸 Snapshot: ${local} (${snap.trigger})\x1b[0m\n`);
      for (const s of snap.sessions) {
        console.log(`\x1b[33m${s.name}\x1b[0m (${s.windows.length} windows)`);
        for (const w of s.windows) {
          console.log(`  ${w.name}`);
        }
      }
    } else if (sub === "snapshot") {
      const { takeSnapshot } = await import("../snapshot");
      const path = await takeSnapshot("manual");
      console.log(`\x1b[32m📸\x1b[0m snapshot saved: ${path}`);
    } else if (!sub) {
      await cmdFleetLs();
    }
    return true;
  }
  if (cmd === "pulse") {
    const subcmd = args[1];
    if (subcmd === "add") {
      const pulseOpts: { oracle?: string; priority?: string; wt?: string } = {};
      let title = "";
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--oracle" && args[i + 1]) { pulseOpts.oracle = args[++i]; }
        else if (args[i] === "--priority" && args[i + 1]) { pulseOpts.priority = args[++i]; }
        else if ((args[i] === "--wt" || args[i] === "--worktree") && args[i + 1]) { pulseOpts.wt = args[++i]; }
        else if (!title) { title = args[i]; }
      }
      if (!title) { console.error('usage: maw pulse add "task title" --oracle <name> [--wt <repo>]'); process.exit(1); }
      await cmdPulseAdd(title, pulseOpts);
    } else if (subcmd === "ls" || subcmd === "list") {
      const sync = args.includes("--sync");
      await cmdPulseLs({ sync });
    } else if (subcmd === "cleanup" || subcmd === "clean") {
      const { scanWorktrees, cleanupWorktree } = await import("../worktrees");
      const worktrees = await scanWorktrees();
      const stale = worktrees.filter(wt => wt.status !== "active");
      if (!stale.length) { console.log("\x1b[32m✓\x1b[0m All worktrees are active. Nothing to clean."); process.exit(0); }
      console.log(`\n\x1b[36mWorktree Cleanup\x1b[0m\n`);
      console.log(`  \x1b[32m${worktrees.filter(w => w.status === "active").length} active\x1b[0m | \x1b[33m${worktrees.filter(w => w.status === "stale").length} stale\x1b[0m | \x1b[31m${worktrees.filter(w => w.status === "orphan").length} orphan\x1b[0m\n`);
      for (const wt of stale) {
        const color = wt.status === "orphan" ? "\x1b[31m" : "\x1b[33m";
        console.log(`${color}${wt.status}\x1b[0m  ${wt.name} (${wt.mainRepo}) [${wt.branch}]`);
        if (!args.includes("--dry-run")) {
          const log = await cleanupWorktree(wt.path);
          for (const line of log) console.log(`  \x1b[32m✓\x1b[0m ${line}`);
        }
      }
      if (args.includes("--dry-run")) console.log(`\n\x1b[90m(dry run — use without --dry-run to clean)\x1b[0m`);
      console.log();
    } else {
      console.error("usage: maw pulse <add|ls|cleanup> [opts]");
      process.exit(1);
    }
    return true;
  }
  if (cmd === "overview" || cmd === "warroom" || cmd === "ov") {
    await cmdOverview(args.slice(1));
    return true;
  }
  if (cmd === "mega") {
    const sub = args[1]?.toLowerCase();
    if (sub === "status" || sub === "ls" || sub === "tree" || !sub) {
      await cmdMegaStatus();
    } else if (sub === "stop" || sub === "kill") {
      await cmdMegaStop();
    } else {
      console.log(`\x1b[36mmaw mega\x1b[0m — MegaAgent hierarchical multi-agent system\n`);
      console.log(`  maw mega              Show all teams (hierarchy tree)`);
      console.log(`  maw mega status       Same as above`);
      console.log(`  maw mega stop         Kill all active team panes\n`);
      console.log(`\x1b[90mTo start a MegaAgent run, use /mega-agent in Claude Code\x1b[0m`);
    }
    return true;
  }
  if (cmd === "federation" || cmd === "fed") {
    const sub = args[1]?.toLowerCase();
    if (!sub || sub === "status" || sub === "ls") {
      await cmdFederationStatus();
    } else if (sub === "sync") {
      await cmdFederationSync({
        dryRun: args.includes("--dry-run"),
        check: args.includes("--check"),
        prune: args.includes("--prune"),
        force: args.includes("--force"),
        json: args.includes("--json"),
      });
    } else {
      console.error("usage: maw federation <status|sync> [--dry-run|--check|--prune|--force|--json]");
      process.exit(1);
    }
    return true;
  }
  if (cmd === "reunion") {
    await cmdReunion(args[1]);
    return true;
  }
  if (cmd === "soul-sync" || cmd === "soulsync" || cmd === "ss") {
    if (args.includes("--project")) {
      const { cmdSoulSyncProject } = await import("../commands/soul-sync");
      await cmdSoulSyncProject();
      return true;
    }
    const fromIdx = args.indexOf("--from");
    if (fromIdx !== -1) {
      await cmdSoulSync(args[fromIdx + 1], { from: true });
    } else {
      await cmdSoulSync(args[1]);
    }
    return true;
  }
  if (cmd === "archive") {
    if (!args[1]) { console.error("usage: maw archive <oracle> [--dry-run]"); process.exit(1); }
    await cmdArchive(args[1], { dryRun: args.includes("--dry-run") });
    return true;
  }
  if (cmd === "find" || cmd === "search") {
    if (!args[1]) { console.error("usage: maw find <keyword> [--oracle <name>]"); process.exit(1); }
    const oracleIdx = args.indexOf("--oracle");
    await cmdFind(args[1], { oracle: oracleIdx !== -1 ? args[oracleIdx + 1] : undefined });
    return true;
  }
  return false;
}
