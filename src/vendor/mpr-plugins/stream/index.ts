import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdStream, STREAM_USAGE, type StreamOptions } from "./impl";

export const command = {
  name: "stream",
  description: "Mirror a tmux window into another session with link-window.",
};

function cliOptions(args: string[]): { target: string; opts: StreamOptions } {
  const flags = parseFlags(args, {
    "--into": String,
    "--name": String,
    "--unlink": Boolean,
  }, 0);
  const target = flags._[0];
  if (!target || target === "--help" || target === "-h" || target.startsWith("-") || flags._.length !== 1) {
    throw new Error(STREAM_USAGE);
  }
  const unlink = Boolean(flags["--unlink"]);
  if (unlink && (flags["--into"] || flags["--name"])) {
    throw new Error("stream: --unlink takes only <session>:<alias>");
  }
  return {
    target,
    opts: {
      into: flags["--into"],
      name: flags["--name"],
      unlink,
    },
  };
}

function apiOptions(args: Record<string, unknown>): { target: string; opts: StreamOptions } {
  const target = typeof args.target === "string" ? args.target : "";
  if (!target) throw new Error("target is required");
  const unlink = Boolean(args.unlink);
  const into = typeof args.into === "string" ? args.into : undefined;
  const name = typeof args.name === "string" ? args.name : undefined;
  if (unlink && (into || name)) {
    throw new Error("stream: --unlink takes only <session>:<alias>");
  }
  return {
    target,
    opts: { into, name, unlink },
  };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    const parsed = ctx.source === "cli"
      ? cliOptions(ctx.args as string[])
      : apiOptions(ctx.args as Record<string, unknown>);
    await cmdStream(parsed.target, parsed.opts);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}
