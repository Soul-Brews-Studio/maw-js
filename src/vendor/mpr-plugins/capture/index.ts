import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdCapture } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "capture",
  description: "Capture visible pane output or full scrollback; use peek for a quick latest-output glance.",
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
    let opts: { pane?: number; lines?: number; full?: boolean } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, {
        "--pane": Number,
        "--lines": Number,
        "--full": Boolean,
      }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw capture <target> [--pane N] [--lines N] [--full]  (see: maw peek for quick glance)" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw capture <target>  (see: maw peek for quick glance)` };
      }
      opts = {
        pane: flags["--pane"],
        lines: flags["--lines"],
        full: flags["--full"],
      };
    } else {
      const body = ctx.args as Record<string, unknown>;
      if (!body.target) return { ok: false, error: "target is required" };
      target = body.target as string;
      opts = {
        pane: body.pane as number | undefined,
        lines: body.lines as number | undefined,
        full: body.full as boolean | undefined,
      };
    }

    await cmdCapture(target, opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
