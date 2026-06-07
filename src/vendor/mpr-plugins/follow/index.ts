import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdFollow, FOLLOW_USAGE, type FollowOptions } from "./impl";

export const command = {
  name: "follow",
  description: "Follow live pane output through the PTY websocket bridge.",
};

function cliOptions(args: string[]): { target: string; opts: FollowOptions } {
  const flags = parseFlags(args, {
    "--since": String,
    "--json": Boolean,
    "--grep": String,
    "--quit-on-idle": String,
  }, 0);
  const target = flags._[0];
  if (!target || target === "--help" || target === "-h" || target.startsWith("-")) {
    throw new Error(FOLLOW_USAGE);
  }
  return {
    target,
    opts: {
      since: flags["--since"],
      json: Boolean(flags["--json"]),
      grep: flags["--grep"],
      quitOnIdle: flags["--quit-on-idle"],
    },
  };
}

function apiOptions(args: Record<string, unknown>): { target: string; opts: FollowOptions } {
  const target = typeof args.target === "string" ? args.target : "";
  if (!target) throw new Error("target is required");
  return {
    target,
    opts: {
      since: typeof args.since === "string" ? args.since : undefined,
      json: Boolean(args.json),
      grep: typeof args.grep === "string" ? args.grep : undefined,
      quitOnIdle: typeof args.quitOnIdle === "string" ? args.quitOnIdle : undefined,
    },
  };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    const parsed = ctx.source === "cli"
      ? cliOptions(ctx.args as string[])
      : apiOptions(ctx.args as Record<string, unknown>);
    await cmdFollow(parsed.target, parsed.opts);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}
