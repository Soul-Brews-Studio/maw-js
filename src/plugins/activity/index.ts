import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { ACTIVITY_USAGE, cmdActivity, type ActivityOptions } from "./impl";

export const command = {
  name: "activity",
  description: "Classify pane activity by diffing peek snapshots.",
};

function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function cliOptions(args: string[]): { target?: string; opts: ActivityOptions } {
  const flags = parseFlags(args, {
    "--watch": Boolean,
    "--all": Boolean,
    "--json": Boolean,
    "--stuck-only": Boolean,
    "--window": String,
    "--samples": String,
    "--sampler": String,
  }, 0);
  const target = flags._[0];
  if (target === "--help" || target === "-h") throw new Error(ACTIVITY_USAGE);
  if (target?.startsWith("-")) throw new Error(ACTIVITY_USAGE);
  const all = Boolean(flags["--all"]);
  if (all && target) throw new Error(ACTIVITY_USAGE);
  if (!all && !target) throw new Error(ACTIVITY_USAGE);
  return {
    target,
    opts: {
      all,
      watch: Boolean(flags["--watch"]),
      json: Boolean(flags["--json"]),
      stuckOnly: Boolean(flags["--stuck-only"]),
      window: flags["--window"],
      samples: numberFlag(flags["--samples"]),
      sampler: flags["--sampler"],
    },
  };
}

function apiOptions(args: Record<string, unknown>): { target?: string; opts: ActivityOptions } {
  const all = Boolean(args.all);
  const target = typeof args.target === "string" ? args.target : undefined;
  if (all && target) throw new Error("target cannot be combined with all");
  if (!all && !target) throw new Error("target is required");
  return {
    target,
    opts: {
      all,
      watch: Boolean(args.watch),
      json: Boolean(args.json),
      stuckOnly: Boolean(args.stuckOnly ?? args.stuck_only),
      window: typeof args.window === "string" ? args.window : undefined,
      samples: typeof args.samples === "number" ? args.samples : undefined,
      sampler: typeof args.sampler === "string" ? args.sampler : undefined,
    },
  };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    const parsed = ctx.source === "cli"
      ? cliOptions(ctx.args as string[])
      : apiOptions(ctx.args as Record<string, unknown>);
    await cmdActivity(parsed.target, parsed.opts);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}
