import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdPanes } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "panes",
  description: "List pane metadata; use pane swap to move panes or tile to arrange/spawn grids.",
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
    let target: string | undefined;

    let pid = false;
    let all = false;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, { "--pid": Boolean, "--all": Boolean, "-a": "--all" }, 0);

      const first = flags._[0];
      if (first === "--help" || first === "-h") {
        return { ok: false, error: "usage: maw panes [target] [--pid] [--all|-a]  (see: maw pane swap, maw tile)" };
      }
      if (first && first.startsWith("-")) {
        return { ok: false, error: `"${first}" looks like a flag, not a target.\n  usage: maw panes [target] [--pid] [--all|-a]  (see: maw pane swap, maw tile)` };
      }
      target = first;
      pid = !!flags["--pid"];
      all = !!flags["--all"];
    } else {
      const body = ctx.args as Record<string, unknown>;
      target = body.target as string | undefined;
      pid = !!body.pid;
      all = !!body.all;
    }

    await cmdPanes(target, { pid, all });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
