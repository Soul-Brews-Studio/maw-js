import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdDone, cmdDoneAll } from "./impl";

export const command = {
  name: ["done", "finish"],
  description: "Finish a worktree session: retrospective/save, kill window, and remove worktree.",
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
    let name: string | undefined;
    let force: boolean | undefined;
    let dryRun: boolean | undefined;
    let all: boolean | undefined;
    let cleanBranch: boolean | undefined;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      // Find first non-flag arg
      const positional = args.filter(a => !a.startsWith("--"));
      force = args.includes("--force");
      dryRun = args.includes("--dry-run");
      all = args.includes("--all");
      cleanBranch = args.includes("--clean-branch");
      if (all && positional.length > 1) {
        const ignored = positional.slice(1).join(" ");
        return { ok: false, error: `unexpected extra positional arg(s) for maw done --all: ${ignored}\n  usage: maw done --all [<oracle>] [--force] [--dry-run] [--clean-branch]` };
      }
      if (!all && positional.length > 1) {
        const ignored = positional.slice(1).join(" ");
        const hint = positional[0]?.toLowerCase() === "all" ? "\n  did you mean `maw done --all`?" : "";
        return { ok: false, error: `unexpected extra positional arg(s) for maw done: ${ignored}${hint}\n  usage: maw done <window-name> [--force] [--dry-run] [--clean-branch] or maw done --all [<oracle>] [--force] [--dry-run] [--clean-branch]` };
      }
      name = positional[0];
    } else {
      const args = ctx.args as Record<string, unknown>;
      name = args.name as string | undefined;
      force = args.force as boolean | undefined;
      dryRun = args.dryRun as boolean | undefined;
      all = args.all as boolean | undefined;
      cleanBranch = (args.cleanBranch ?? args.clean_branch) as boolean | undefined;
      if (all && (args.oracle || args.name)) {
        name = (args.oracle as string | undefined) ?? name;
      }
    }

    if (all) {
      await cmdDoneAll({ force: Boolean(force), dryRun: Boolean(dryRun), cleanBranch: Boolean(cleanBranch), oracle: name, cwd: process.cwd() });
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (!name) {
      return { ok: false, error: "usage: maw done <window-name> [--force] [--dry-run] [--clean-branch] or maw done --all [<oracle>] [--force] [--dry-run] [--clean-branch]  (see: maw sleep/kill for non-worktree shutdown)" };
    }

    await cmdDone(name, { force: Boolean(force), dryRun: Boolean(dryRun), cleanBranch: Boolean(cleanBranch), cwd: process.cwd() });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
