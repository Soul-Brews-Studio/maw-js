import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdCosts, cmdCostsDaily } from "./impl";

export const command = {
  name: "costs",
  description: "Show token usage and estimated cost breakdown per agent.",
};

/**
 * Inject a default numeric value after `--daily` when no value follows.
 * `arg` typed as Number throws "option requires argument" if --daily is bare
 * (e.g. `maw costs --daily` or `maw costs --daily --json`).
 */
function injectDailyDefault(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    result.push(args[i]);
    if (args[i] === "--daily") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        result.push("7"); // default window
      }
    }
  }
  return result;
}

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
    if (ctx.source === "cli") {
      const rawArgs = ctx.args as string[];
      // Pre-process: inject default "7" after --daily if no numeric value follows.
      // `arg` throws "option requires argument" when --daily is typed as Number
      // and is followed by another flag or is the last arg.
      const args = injectDailyDefault(rawArgs);
      const flags = parseFlags(
        args,
        {
          "--daily": Number,
          "--json": Boolean,
          "-j": "--json",
        },
        0,
      );

      if (flags["--daily"] !== undefined) {
        const days = flags["--daily"] || 7; // NaN guard (shouldn't happen after inject)
        await cmdCostsDaily(days, !!flags["--json"]);
      } else {
        await cmdCosts();
      }
    } else {
      // API / peer source: check args object
      const body = ctx.args as Record<string, unknown>;
      if (body.daily !== undefined) {
        const days = Number(body.days ?? body.daily ?? 7);
        await cmdCostsDaily(isNaN(days) ? 7 : days, !!body.json);
      } else {
        await cmdCosts();
      }
    }
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return {
      ok: false,
      error: e.message ?? String(e),
      output: logs.join("\n") || undefined,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
