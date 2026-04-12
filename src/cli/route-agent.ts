import { cmdWake, fetchIssuePrompt } from "../commands/wake";
import { parseWakeTarget, ensureCloned } from "../commands/wake-target";
import { cmdWakeAll, cmdSleep } from "../commands/fleet";
import { cmdDone } from "../commands/done";
import { cmdSleepOne } from "../commands/sleep";
import { cmdOracleList, cmdOracleAbout, cmdOracleScan, cmdOracleFleet } from "../commands/oracle";
import { cmdTake } from "../commands/take";
import { cmdBud } from "../commands/bud";

export async function routeAgent(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "wake") {
    if (!args[1]) { console.error("usage: maw wake <oracle|org/repo|URL> [task] [--new <name>] [--fresh] [--no-attach] [--list]\n       maw wake all [--kill]"); process.exit(1); }
    if (args[1].toLowerCase() === "all") {
      await cmdWakeAll({ kill: args.includes("--kill"), all: args.includes("--all"), resume: args.includes("--resume") });
    } else {
      const wakeOpts: { task?: string; newWt?: string; prompt?: string; incubate?: string; fresh?: boolean; noAttach?: boolean; listWt?: boolean } = {};
      let issueNum: number | null = null;
      let repo: string | undefined;
      // Detect URL or org/repo slug → clone via ghq, then let resolveOracle find it
      const parsed = parseWakeTarget(args[1]);
      const oracleName = parsed ? parsed.oracle : args[1];
      if (parsed) {
        await ensureCloned(parsed.slug);
        if (parsed.issueNum) { issueNum = parsed.issueNum; repo = parsed.slug; }
      }
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--new" && args[i + 1]) { wakeOpts.newWt = args[++i]; }
        else if (args[i] === "--incubate" && args[i + 1]) { wakeOpts.incubate = args[++i]; }
        else if (args[i] === "--issue" && args[i + 1]) { issueNum = +args[++i]; }
        else if (args[i] === "--repo" && args[i + 1]) { repo = args[++i]; }
        else if (args[i] === "--fresh") { wakeOpts.fresh = true; }
        else if (args[i] === "--no-attach") { wakeOpts.noAttach = true; }
        else if (args[i] === "--list" || args[i] === "--ls") { wakeOpts.listWt = true; }
        else if (!wakeOpts.task) { wakeOpts.task = args[i]; }
        else if (!wakeOpts.prompt) { wakeOpts.prompt = args.slice(i).join(" "); break; }
      }
      if (wakeOpts.incubate && !repo) { repo = wakeOpts.incubate; }
      if (issueNum) {
        console.log(`\x1b[36m⚡\x1b[0m fetching issue #${issueNum}...`);
        wakeOpts.prompt = await fetchIssuePrompt(issueNum, repo);
        if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
      }
      await cmdWake(oracleName, wakeOpts);
    }
    return true;
  }
  if (cmd === "sleep") {
    if (!args[1]) {
      console.error("usage: maw sleep <oracle> [window]\n       maw sleep neo          # sleep neo-oracle\n       maw sleep neo mawjs    # sleep neo-mawjs worktree\n       maw stop               # stop ALL fleet sessions");
      process.exit(1);
    } else if (args[1] === "--all-done") {
      console.log("\x1b[90m(placeholder) maw sleep --all-done — sleep ALL agents. Not yet implemented.\x1b[0m");
    } else {
      await cmdSleepOne(args[1], args[2]);
    }
    return true;
  }
  if (cmd === "done" || cmd === "finish") {
    if (!args[1]) { console.error("usage: maw done <window-name> [--force] [--dry-run]\n       e.g. maw done neo-freelance"); process.exit(1); }
    const force = args.includes("--force");
    const dryRun = args.includes("--dry-run");
    const name = args.slice(1).find(a => !a.startsWith("--"))!;
    await cmdDone(name, { force, dryRun });
    return true;
  }
  if (cmd === "stop" || cmd === "rest") {
    await cmdSleep();
    return true;
  }
  if (cmd === "about" || cmd === "info") {
    if (!args[1]) { console.error("usage: maw about <oracle>"); process.exit(1); }
    await cmdOracleAbout(args[1]);
    return true;
  }
  if (cmd === "take" || cmd === "handover") {
    if (!args[1]) { console.error("usage: maw take <session>:<window> [target-session]\n  e.g. maw take neo:neo-skills pulse"); process.exit(1); }
    await cmdTake(args[1], args[2]);
    return true;
  }
  if (cmd === "bud") {
    if (!args[1] || args[1] === "--help" || args[1] === "-h") { console.error("usage: maw bud <name> [--from <oracle>] [--root] [--org <org>] [--repo org/repo] [--issue N] [--note <text>] [--fast] [--dry-run]"); process.exit(1); }
    // Guard: if first arg looks like a flag, user forgot the name
    if (args[1].startsWith("--")) {
      console.error(`  \x1b[31m✗\x1b[0m "${args[1]}" looks like a flag, not an oracle name.`);
      console.error(`  \x1b[90m  usage: maw bud <name> ${args.slice(1).join(" ")}\x1b[0m`);
      process.exit(1);
    }
    const budOpts: { from?: string; repo?: string; org?: string; issue?: number; fast?: boolean; root?: boolean; dryRun?: boolean; note?: string } = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--from" && args[i + 1]) budOpts.from = args[++i];
      else if (args[i] === "--org" && args[i + 1]) budOpts.org = args[++i];
      else if (args[i] === "--repo" && args[i + 1]) budOpts.repo = args[++i];
      else if (args[i] === "--issue" && args[i + 1]) budOpts.issue = +args[++i];
      else if (args[i] === "--note" && args[i + 1]) budOpts.note = args[++i];
      else if (args[i] === "--fast") budOpts.fast = true;
      else if (args[i] === "--root") budOpts.root = true;
      else if (args[i] === "--dry-run") budOpts.dryRun = true;
    }
    await cmdBud(args[1], budOpts);
    return true;
  }
  if (cmd === "oracle" || cmd === "oracles") {
    const subcmd = args[1]?.toLowerCase();
    if (!subcmd || subcmd === "ls" || subcmd === "list") {
      await cmdOracleList();
    } else if (subcmd === "scan") {
      const json = args.includes("--json");
      const force = args.includes("--force");
      const local = args.includes("--local");
      const remote = args.includes("--remote");
      const all = args.includes("--all");
      const verbose = args.includes("--verbose") || args.includes("-v");
      await cmdOracleScan({ json, force, local, remote, all, verbose });
    } else if (subcmd === "fleet") {
      const json = args.includes("--json");
      const stale = args.includes("--stale");
      const orgIdx = args.indexOf("--org");
      const org = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
      await cmdOracleFleet({ json, stale, org });
    } else if (subcmd === "about" && args[2]) {
      await cmdOracleAbout(args[2]);
    } else {
      console.error("usage: maw oracle [ls|scan|fleet|about <name>]");
      process.exit(1);
    }
    return true;
  }
  return false;
}
