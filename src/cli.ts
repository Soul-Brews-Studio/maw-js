#!/usr/bin/env bun
process.env.MAW_CLI = "1";

import { cmdList, cmdPeek, cmdSend } from "./commands/comm";
import { cmdView } from "./commands/view";
import { cmdCompletions } from "./commands/completions";
import { cmdOverview } from "./commands/overview";
import { cmdWake, fetchIssuePrompt } from "./commands/wake";
import { cmdPulseAdd, cmdPulseLs } from "./commands/pulse";
import { cmdOracleList, cmdOracleAbout } from "./commands/oracle";
import { cmdWakeAll, cmdSleep, cmdFleetLs, cmdFleetRenumber, cmdFleetValidate, cmdFleetSync } from "./commands/fleet";
import { cmdFleetInit } from "./commands/fleet-init";
import { cmdDone } from "./commands/done";
import { cmdLogLs, cmdLogExport } from "./commands/log";

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase();

function usage() {
  console.log(`\x1b[36mmaw\x1b[0m — Multi-Agent Workflow

\x1b[33mUsage:\x1b[0m
  maw ls                      List sessions + windows
  maw peek [agent]            Peek agent screen (or all)
  maw hey <agent> <msg...>    Send message to agent (alias: tell)
  maw wake <oracle> [task]    Wake oracle in tmux window + claude
  maw wake <oracle> --issue N Wake oracle with GitHub issue as prompt
  maw fleet init              Scan ghq repos, generate fleet/*.json
  maw fleet ls                List fleet configs with conflict detection
  maw fleet renumber          Fix numbering conflicts (sequential)
  maw fleet validate          Check for problems (dupes, orphans, missing repos)
  maw fleet sync              Add unregistered windows to fleet configs
  maw wake all [--kill]       Wake fleet (01-15 + 99, skips dormant 20+)
  maw wake all --all          Wake ALL including dormant
  maw wake all --resume       Wake fleet + send /recap to active board items
  maw stop                    Stop all fleet sessions
  maw about <oracle>           Oracle profile — session, worktrees, fleet
  maw oracle ls               Fleet status (awake/sleeping/worktrees)
  maw overview              War-room: all oracles in split panes
  maw overview neo hermes   Only specific oracles
  maw overview --kill       Tear down overview
  maw done <window>            Clean up finished worktree window
  maw pulse add "task" [opts] Create issue + wake oracle
  maw pulse cleanup [--dry-run] Clean stale/orphan worktrees
  maw view <agent> [window]   Grouped tmux session (interactive attach)
  maw create-view <agent> [w] Alias for view
  maw view <agent> --clean    Hide status bar (full screen)
  maw <agent> <msg...>        Shorthand for hey
  maw <agent>                 Shorthand for peek
  maw serve [port]            Start web UI (default: 3456)

\x1b[33mWake modes:\x1b[0m
  maw wake neo                Wake main repo
  maw wake hermes bitkub      Wake existing worktree
  maw wake neo --new free     Create worktree + wake
  maw wake neo --issue 5      Fetch issue #5 + send as claude -p prompt
  maw wake neo --issue 5 --repo org/repo   Explicit repo

\x1b[33mPulse add:\x1b[0m
  maw pulse ls                Board table (terminal)
  maw pulse ls --sync         + update daily thread checkboxes
  maw pulse add "Fix bug" --oracle neo
  maw pulse add "task" --oracle neo --wt oracle-v2

\x1b[33mEnv:\x1b[0m
  MAW_HOST=white.local        SSH target (default: white.local)

\x1b[33mExamples:\x1b[0m
  maw wake neo --new bitkub   Create worktree + start claude
  maw pulse add "Fix IME" --oracle neo --priority P1
  maw hey neo what is your status
  maw serve 8080`);
}

// --- Main Router ---

if (cmd === "--version" || cmd === "-v") {
  const pkg = require("../package.json");
  let hash = "";
  try { hash = require("child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim(); } catch {}
  console.log(`maw v${pkg.version}${hash ? ` (${hash})` : ""}`);
} else if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "ls" || cmd === "list") {
  await cmdList();
} else if (cmd === "peek" || cmd === "see") {
  await cmdPeek(args[1]);
} else if (cmd === "hey" || cmd === "send" || cmd === "tell") {
  const force = args.includes("--force");
  const msgArgs = args.slice(2).filter(a => a !== "--force");
  if (!args[1] || !msgArgs.length) { console.error("usage: maw hey <agent> <message> [--force]"); process.exit(1); }
  await cmdSend(args[1], msgArgs.join(" "), force);
} else if (cmd === "fleet" && args[1] === "init") {
  await cmdFleetInit();
} else if (cmd === "fleet" && args[1] === "ls") {
  await cmdFleetLs();
} else if (cmd === "fleet" && args[1] === "renumber") {
  await cmdFleetRenumber();
} else if (cmd === "fleet" && args[1] === "validate") {
  await cmdFleetValidate();
} else if (cmd === "fleet" && args[1] === "sync") {
  await cmdFleetSync();
} else if (cmd === "fleet" && !args[1]) {
  await cmdFleetLs();
} else if (cmd === "log") {
  const sub = args[1]?.toLowerCase();
  if (sub === "export") {
    const logOpts: { date?: string; from?: string; to?: string; format?: string } = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--date" && args[i + 1]) logOpts.date = args[++i];
      else if (args[i] === "--from" && args[i + 1]) logOpts.from = args[++i];
      else if (args[i] === "--to" && args[i + 1]) logOpts.to = args[++i];
      else if (args[i] === "--format" && args[i + 1]) logOpts.format = args[++i];
    }
    cmdLogExport(logOpts);
  } else {
    const logOpts: { limit?: number; from?: string; to?: string } = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--limit" && args[i + 1]) logOpts.limit = +args[++i];
      else if (args[i] === "--from" && args[i + 1]) logOpts.from = args[++i];
      else if (args[i] === "--to" && args[i + 1]) logOpts.to = args[++i];
    }
    cmdLogLs(logOpts);
  }
} else if (cmd === "done" || cmd === "finish") {
  if (!args[1]) { console.error("usage: maw done <window-name>\n       e.g. maw done neo-freelance"); process.exit(1); }
  await cmdDone(args[1]);
} else if (cmd === "stop" || cmd === "sleep" || cmd === "rest") {
  await cmdSleep();
} else if (cmd === "wake") {
  if (!args[1]) { console.error("usage: maw wake <oracle> [task] [--new <name>]\n       maw wake all [--kill]"); process.exit(1); }
  if (args[1].toLowerCase() === "all") {
    await cmdWakeAll({ kill: args.includes("--kill"), all: args.includes("--all"), resume: args.includes("--resume") });
  } else {
    const wakeOpts: { task?: string; newWt?: string; prompt?: string } = {};
    let issueNum: number | null = null;
    let repo: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--new" && args[i + 1]) { wakeOpts.newWt = args[++i]; }
      else if (args[i] === "--issue" && args[i + 1]) { issueNum = +args[++i]; }
      else if (args[i] === "--repo" && args[i + 1]) { repo = args[++i]; }
      else if (!wakeOpts.task) { wakeOpts.task = args[i]; }
    }
    if (issueNum) {
      console.log(`\x1b[36m⚡\x1b[0m fetching issue #${issueNum}...`);
      wakeOpts.prompt = await fetchIssuePrompt(issueNum, repo);
      if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
    }
    await cmdWake(args[1], wakeOpts);
  }
} else if (cmd === "pulse") {
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
    const { scanWorktrees, cleanupWorktree } = await import("./worktrees");
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
} else if (cmd === "overview" || cmd === "warroom" || cmd === "ov") {
  await cmdOverview(args.slice(1));
} else if (cmd === "about" || cmd === "info") {
  if (!args[1]) { console.error("usage: maw about <oracle>"); process.exit(1); }
  await cmdOracleAbout(args[1]);
} else if (cmd === "oracle" || cmd === "oracles") {
  const subcmd = args[1]?.toLowerCase();
  if (!subcmd || subcmd === "ls" || subcmd === "list") {
    await cmdOracleList();
  } else {
    console.error("usage: maw oracle ls");
    process.exit(1);
  }
} else if (cmd === "completions") {
  await cmdCompletions(args[1]);
} else if (cmd === "view" || cmd === "create-view" || cmd === "attach") {
  if (!args[1]) { console.error("usage: maw view <agent> [window] [--clean]"); process.exit(1); }
  const clean = args.includes("--clean");
  const viewArgs = args.slice(1).filter(a => a !== "--clean");
  await cmdView(viewArgs[0], viewArgs[1], clean);
} else if (cmd === "serve") {
  const { startServer } = await import("./server");
  startServer(args[1] ? +args[1] : 3456);
} else {
  // Default: agent name shorthand
  if (args.length >= 2) {
    const f = args.includes("--force");
    const m = args.slice(1).filter(a => a !== "--force");
    await cmdSend(args[0], m.join(" "), f);
  } else {
    await cmdPeek(args[0]);
  }
}
