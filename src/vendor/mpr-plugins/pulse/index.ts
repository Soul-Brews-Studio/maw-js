import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "pulse",
  description: "Task pulse — add, list, and clean up work items.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const subcmd = args[0];

    if (subcmd === "add") {
      const flags = parseFlags(args.slice(1), {
        "--oracle": String,
        "--priority": String,
        "--wt": String,
        "--worktree": "--wt",
      }, 0);
      const title = flags._.find(a => !a.startsWith("--")) ?? "";
      const pulseOpts = {
        oracle: flags["--oracle"],
        priority: flags["--priority"],
        wt: flags["--wt"],
      };
      if (!title) {
        return {
          ok: false,
          error: 'usage: maw pulse add "task title" --oracle <name> [--wt <repo>]',
        };
      }
      const { cmdPulseAdd } = await import("maw-js/commands/shared/pulse");
      await cmdPulseAdd(title, pulseOpts);
    } else if (subcmd === "ls" || subcmd === "list") {
      const sync = args.includes("--sync");
      const { cmdPulseLs } = await import("maw-js/commands/shared/pulse");
      await cmdPulseLs({ sync });
    } else if (subcmd === "cleanup" || subcmd === "clean") {
      const { scanWorktrees, cleanupWorktree } = await import("maw-js/worktrees");
      const worktrees = await scanWorktrees();
      const stale = worktrees.filter(wt => wt.status !== "active");
      if (!stale.length) {
        console.log("\x1b[32m✓\x1b[0m All worktrees are active. Nothing to clean.");
        return { ok: true, output: logs.join("\n") || undefined };
      }
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
      return {
        ok: false,
        error: "usage: maw pulse <add|ls|cleanup> [opts]",
      };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
