/**
 * `maw bg` — background tmux session plugin (#1304).
 *
 * Usage:
 *   maw bg <name> "<cmd>"            # spawn detached (default), return immediately
 *   maw bg <name> "<cmd>" --attach   # spawn AND attach
 *
 * The command receives the caller's $PWD via `tmux new-session -c <cwd>` so
 * cd'ing into a repo and running `maw bg dev "bun run dev"` starts dev from
 * that repo.
 *
 * See `maw shell` for the opposite-default sibling (interactive shells).
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdBg } from "./impl";

export const command = {
  name: "bg",
  description: "Spawn a background command in a tmux session (#1304).",
};

function printUsage(): void {
  console.log("usage: maw bg <name> \"<cmd>\" [--attach]");
  console.log("  <name>     tmux session name");
  console.log("  <cmd>      command to run in the new session (quote if multi-word)");
  console.log("  --attach   attach after spawning (default: detached)");
  console.log("");
  console.log("examples:");
  console.log("  maw bg dev \"bun run dev\"           # spawn + return");
  console.log("  maw bg watcher \"tail -f log.txt\"   # spawn + return");
  console.log("  maw bg srv \"bun run dev\" --attach  # spawn AND attach (rare)");
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
    // skip=0: ctx.args from the dispatcher is already stripped of the command
    // name (src/cli/dispatch.ts ~L82: `args.slice(matchedWords)`). Pre-#1306
    // this was skip=1 which silently ate the first positional, making
    // `maw bg <name> "<cmd>"` always error with "session name required". The
    // shipped tests passed a leading command name so they didn't catch it —
    // tests updated alongside this fix.
    const flags = parseFlags(args, {
      "--attach":    Boolean,
      "--no-attach": Boolean,
      "--help":      Boolean, "-h": "--help",
    }, 0);

    if (flags["--help"]) {
      printUsage();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const positional = flags._ as string[];
    const name = positional[0];
    // Everything after <name> is the command. We re-join so users who didn't
    // quote on a tmux-friendly shell still get a sensible command string.
    const cmd = positional.slice(1).join(" ");

    if (!name) {
      printUsage();
      return { ok: false, error: "session name required", output: logs.join("\n") };
    }
    if (!cmd) {
      printUsage();
      return { ok: false, error: "command required", output: logs.join("\n") };
    }

    // --attach opt-in; --no-attach explicit even though it's the default
    // (so `maw shell foo --no-attach || maw bg foo "cmd" --no-attach`
    //  reads symmetrically in scripts).
    const attach = !!flags["--attach"] && !flags["--no-attach"];
    await cmdBg(name, cmd, { attach });

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
