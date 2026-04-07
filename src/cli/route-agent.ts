import { cmdWake, fetchIssuePrompt } from "../commands/wake";
import { cmdWakeAll, cmdSleep } from "../commands/fleet";
import { cmdDone } from "../commands/done";
import { cmdSleepOne } from "../commands/sleep";
import { cmdOracleList, cmdOracleAbout } from "../commands/oracle";
import { cmdBud } from "../commands/bud";
import { cmdTake } from "../commands/take";
import { cmdThink, type ThinkPhase } from "../commands/think";

export async function routeAgent(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "wake") {
    if (!args[1]) { console.error("usage: maw wake <oracle> [task] [--new <name>] [--fresh] [--no-attach] [--list]\n       maw wake all [--kill]"); process.exit(1); }
    if (args[1].toLowerCase() === "all") {
      await cmdWakeAll({ kill: args.includes("--kill"), all: args.includes("--all"), resume: args.includes("--resume") });
    } else {
      const wakeOpts: { task?: string; newWt?: string; prompt?: string; incubate?: string; fresh?: boolean; noAttach?: boolean; listWt?: boolean } = {};
      let issueNum: number | null = null;
      let repo: string | undefined;
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
      await cmdWake(args[1], wakeOpts);
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
    if (!args[1]) { console.error("usage: maw done <window-name> [--force] [--dry-run] [--archive]\n       e.g. maw done neo-freelance"); process.exit(1); }
    const force = args.includes("--force");
    const dryRun = args.includes("--dry-run");
    const archive = args.includes("--archive");
    const name = args.slice(1).find(a => !a.startsWith("--"))!;
    await cmdDone(name, { force, dryRun, archive });
    return true;
  }
  if (cmd === "bud") {
    if (!args[1]) {
      console.error("usage: maw bud <name> [--from <oracle>] [--repo org/repo] [--issue N] [--fast] [--dry-run]");
      process.exit(1);
    }
    const budOpts: { from?: string; repo?: string; issue?: number; fast?: boolean; dryRun?: boolean } = {};
    const budName = args[1];
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--from" && args[i + 1]) { budOpts.from = args[++i]; }
      else if (args[i] === "--repo" && args[i + 1]) { budOpts.repo = args[++i]; }
      else if (args[i] === "--issue" && args[i + 1]) { budOpts.issue = +args[++i]; }
      else if (args[i] === "--fast") { budOpts.fast = true; }
      else if (args[i] === "--dry-run") { budOpts.dryRun = true; }
    }
    await cmdBud(budName, budOpts);
    return true;
  }
  if (cmd === "take") {
    if (!args[1]) {
      console.error("usage: maw take <oracle>:<window>\n       e.g. maw take neo:dashboard");
      process.exit(1);
    }
    await cmdTake(args[1]);
    return true;
  }
  if (cmd === "think" || cmd === "consciousness") {
    const thinkOpts: { oracle?: string; phase?: ThinkPhase; loop?: boolean; interval?: number; fleet?: boolean; dryRun?: boolean } = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--oracle" && args[i + 1]) { thinkOpts.oracle = args[++i]; }
      else if (args[i] === "--phase" && args[i + 1]) { thinkOpts.phase = args[++i] as ThinkPhase; }
      else if (args[i] === "--loop") { thinkOpts.loop = true; }
      else if (args[i] === "--interval" && args[i + 1]) { thinkOpts.interval = +args[++i]; }
      else if (args[i] === "--fleet") { thinkOpts.fleet = true; }
      else if (args[i] === "--dry-run") { thinkOpts.dryRun = true; }
    }
    await cmdThink(thinkOpts);
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
  if (cmd === "oracle" || cmd === "oracles") {
    const subcmd = args[1]?.toLowerCase();
    if (!subcmd || subcmd === "ls" || subcmd === "list") {
      await cmdOracleList();
    } else {
      console.error("usage: maw oracle ls");
      process.exit(1);
    }
    return true;
  }
  return false;
}
