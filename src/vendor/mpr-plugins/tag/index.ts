import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdTag } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "tag",
  description: "Set pane metadata (title + @custom options).",
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
    let opts: { pane?: number; title?: string; meta?: string[] } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, {
        "--pane": Number,
        "--title": String,
        "--meta": [String],
      }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw tag <target> [--pane N] [--title <text>] [--meta key=val]" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw tag <target> ...` };
      }

      opts = {
        pane: flags["--pane"],
        title: flags["--title"],
        meta: flags["--meta"],
      };
    } else {
      const body = ctx.args as Record<string, unknown>;
      if (!body.target) {
        return { ok: false, error: "target is required" };
      }
      target = body.target as string;
      opts = {
        pane: body.pane as number | undefined,
        title: body.title as string | undefined,
        meta: body.meta as string[] | undefined,
      };
    }

    await cmdTag(target, opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
