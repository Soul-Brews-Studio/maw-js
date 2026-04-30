import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdSplit } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "split",
  description: "Split current tmux pane and attach to a session.",
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
    let target: string;
    let opts: { pct?: number; vertical?: boolean; noAttach?: boolean } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, {
        "--pct": Number,
        "--vertical": Boolean,
        "--no-attach": Boolean,
      }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw split <target> [--pct N] [--vertical] [--no-attach]" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw split <target>` };
      }

      opts = {
        pct: flags["--pct"],
        vertical: flags["--vertical"],
        noAttach: flags["--no-attach"],
      };
    } else {
      const body = ctx.args as Record<string, unknown>;
      if (!body.target) {
        return { ok: false, error: "target is required" };
      }
      target = body.target as string;
      opts = {
        pct: body.pct as number | undefined,
        vertical: body.vertical as boolean | undefined,
        noAttach: body.noAttach as boolean | undefined,
      };
    }

    await cmdSplit(target, opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
