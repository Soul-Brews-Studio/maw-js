import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdPanes } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "panes",
  description: "List tmux panes with metadata.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    let target: string | undefined;

    let pid = false;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, { "--pid": Boolean }, 0);

      const first = flags._[0];
      if (first === "--help" || first === "-h") {
        return { ok: false, error: "usage: maw panes [target] [--pid]" };
      }
      if (first && first.startsWith("-")) {
        return { ok: false, error: `"${first}" looks like a flag, not a target.\n  usage: maw panes [target] [--pid]` };
      }
      target = first;
      pid = !!flags["--pid"];
    } else {
      const body = ctx.args as Record<string, unknown>;
      target = body.target as string | undefined;
      pid = !!body.pid;
    }

    await cmdPanes(target, { pid });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
