import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdTag } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "tag",
  description: "Set pane metadata (title + @custom options).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    let target: string;
    let opts: { pane?: number; title?: string; meta?: string[] } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      // Note: --meta is repeatable (key=val each time). parseFlags gives us
      // only the last one, so scan raw args to collect all --meta values.
      const flags = parseFlags(args, {
        "--pane": Number,
        "--title": String,
        "--meta": String,
      }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw tag <target> [--pane N] [--title <text>] [--meta key=val]" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw tag <target> ...` };
      }

      // Collect repeated --meta flags from raw args (parseFlags keeps only last).
      const allMeta: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--meta" && i + 1 < args.length) {
          allMeta.push(args[i + 1]!);
          i++;
        }
      }

      opts = {
        pane: flags["--pane"],
        title: flags["--title"],
        meta: allMeta.length > 0 ? allMeta : undefined,
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
