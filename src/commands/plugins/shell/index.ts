/**
 * `maw shell` — interactive tmux shell session plugin (#1304).
 *
 * Usage:
 *   maw shell <name>              # create and attach (default)
 *   maw shell <name> --no-attach  # create only, return immediately
 *
 * The shell receives the caller's $PWD via `tmux new-session -c <cwd>` so
 * cd'ing into a repo and running `maw shell myrepo` lands you in that repo.
 *
 * See `maw bg` for the opposite-default sibling (background commands).
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdShell } from "./impl";

export const command = {
  name: "shell",
  description: "Spawn an interactive tmux shell session (#1304).",
};

function printUsage(): void {
  console.log("usage: maw shell <name> [--no-attach]");
  console.log("  <name>        tmux session name");
  console.log("  --no-attach   create only, do not attach (default: attach)");
  console.log("");
  console.log("examples:");
  console.log("  maw shell scratch          # create + attach");
  console.log("  maw shell svc --no-attach  # create detached, attach later via 'maw a svc'");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const flags = parseFlags(args, {
      "--no-attach": Boolean,
      "--attach":    Boolean,
      "--help":      Boolean, "-h": "--help",
    }, 1);

    if (flags["--help"]) {
      printUsage();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const positional = flags._ as string[];
    const name = positional[0];
    if (!name) {
      printUsage();
      return { ok: false, error: "session name required", output: logs.join("\n") };
    }

    // --no-attach overrides --attach; default attach=true.
    const attach = !flags["--no-attach"];
    await cmdShell(name, { attach });

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
