import { cmdWake, fetchIssuePrompt } from "../commands/wake";
import { parseWakeTarget, ensureCloned } from "../commands/wake-target";
import { cmdWakeAll, cmdSleep } from "../commands/fleet";
import { cmdDone } from "../commands/done";
import { cmdSleepOne } from "../commands/sleep";
import { cmdOracleList, cmdOracleAbout, cmdOracleScan, cmdOracleFleet } from "../commands/oracle";
import { cmdTake } from "../commands/take";
import { cmdBud } from "../commands/bud";
import { parseFlags } from "./parse-args";

export async function routeAgent(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "wake") {
    if (!args[1]) { console.error("usage: maw wake <oracle|org/repo|URL> [task] [--new <name>] [--fresh] [--no-attach] [--list]\n       maw wake all [--kill]"); process.exit(1); }
    if (args[1].toLowerCase() === "all") {
      const flags = parseFlags(args, { "--kill": Boolean, "--all": Boolean, "--resume": Boolean }, 2);
      await cmdWakeAll({ kill: flags["--kill"], all: flags["--all"], resume: flags["--resume"] });
    } else {
      const flags = parseFlags(args, {
        "--new": String,
        "--incubate": String,
        "--issue": Number,
        "--repo": String,
        "--fresh": Boolean,
        "--no-attach": Boolean,
        "--list": Boolean,
        "--ls": "--list",
      }, 2);

      const wakeOpts: { task?: string; newWt?: string; prompt?: string; incubate?: string; fresh?: boolean; noAttach?: boolean; listWt?: boolean } = {};
      let issueNum: number | null = flags["--issue"] ?? null;
      let repo: string | undefined = flags["--repo"];

      // Detect URL or org/repo slug → clone via ghq
      const parsed = parseWakeTarget(args[1]);
      const oracleName = parsed ? parsed.oracle : args[1];
      if (parsed) {
        await ensureCloned(parsed.slug);
        if (parsed.issueNum) { issueNum = parsed.issueNum; repo = parsed.slug; }
      }

      if (flags["--new"]) wakeOpts.newWt = flags["--new"];
      if (flags["--incubate"]) wakeOpts.incubate = flags["--incubate"];
      if (flags["--fresh"]) wakeOpts.fresh = true;
      if (flags["--no-attach"]) wakeOpts.noAttach = true;
      if (flags["--list"]) wakeOpts.listWt = true;

      // Positional args after oracle name: task, then prompt
      const positionals = flags._;
      if (positionals.length > 0) wakeOpts.task = positionals[0];
      if (positionals.length > 1) wakeOpts.prompt = positionals.slice(1).join(" ");

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
    const flags = parseFlags(args, { "--force": Boolean, "--dry-run": Boolean }, 1);
    const name = flags._[0];
    if (!name) { console.error("usage: maw done <window-name> [--force] [--dry-run]"); process.exit(1); }
    await cmdDone(name, { force: flags["--force"], dryRun: flags["--dry-run"] });
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
    const flags = parseFlags(args, {
      "--from": String,
      "--org": String,
      "--repo": String,
      "--issue": Number,
      "--note": String,
      "--fast": Boolean,
      "--root": Boolean,
      "--dry-run": Boolean,
    }, 1);

    const name = flags._[0];
    if (!name || name === "--help" || name === "-h") {
      console.error("usage: maw bud <name> [--from <oracle>] [--root] [--org <org>] [--repo org/repo] [--issue N] [--note <text>] [--fast] [--dry-run]");
      process.exit(1);
    }
    // Guard: if name looks like a flag, user forgot the name (e.g. "maw bud --from url")
    if (name.startsWith("--")) {
      console.error(`  \x1b[31m✗\x1b[0m "${name}" looks like a flag, not an oracle name.`);
      console.error(`  \x1b[90m  usage: maw bud <name> ${args.slice(1).join(" ")}\x1b[0m`);
      process.exit(1);
    }

    await cmdBud(name, {
      from: flags["--from"],
      repo: flags["--repo"],
      org: flags["--org"],
      issue: flags["--issue"],
      note: flags["--note"],
      fast: flags["--fast"],
      root: flags["--root"],
      dryRun: flags["--dry-run"],
    });
    return true;
  }
  if (cmd === "oracle" || cmd === "oracles") {
    const subcmd = args[1]?.toLowerCase();
    if (!subcmd || subcmd === "ls" || subcmd === "list") {
      await cmdOracleList();
    } else if (subcmd === "scan") {
      const flags = parseFlags(args, {
        "--json": Boolean,
        "--force": Boolean,
        "--local": Boolean,
        "--remote": Boolean,
        "--all": Boolean,
        "--verbose": Boolean,
        "-v": "--verbose",
      }, 2);
      await cmdOracleScan({
        json: flags["--json"],
        force: flags["--force"],
        local: flags["--local"],
        remote: flags["--remote"],
        all: flags["--all"],
        verbose: flags["--verbose"],
      });
    } else if (subcmd === "fleet") {
      const flags = parseFlags(args, {
        "--json": Boolean,
        "--stale": Boolean,
        "--org": String,
      }, 2);
      await cmdOracleFleet({ json: flags["--json"], stale: flags["--stale"], org: flags["--org"] });
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
