/**
 * `maw wait` — block until a tmux session ends (#1306).
 *
 * Usage:
 *   maw wait <name>                        # poll every 5s, no timeout
 *   maw wait <name> --interval 1           # poll every 1s
 *   maw wait <name> --timeout 600          # bail after 10 min (exit 1)
 *
 * Pairs with `maw bg` and `maw shell` (#1304) — the missing third of the
 * POSIX-style job-control trio.
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdWait, WaitTimeoutError } from "./impl";

export const command = {
  name: "wait",
  description: "Block until a tmux session ends (#1306).",
};

function printUsage(): void {
  console.log("usage: maw wait <name> [--interval N] [--timeout N]");
  console.log("  <name>        tmux session name");
  console.log("  --interval N  poll interval in seconds (default: 5)");
  console.log("  --timeout N   bail after N seconds (default: no timeout, exit 1 on bail)");
  console.log("");
  console.log("examples:");
  console.log("  maw wait builder                          # block until 'builder' ends");
  console.log("  maw wait builder --interval 1             # check every second");
  console.log("  maw wait builder --timeout 600            # bail after 10 min");
  console.log("  maw bg t \"sleep 2\" && maw wait t          # spawn + wait pattern");
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
    // name (see src/cli/dispatch.ts ≈L82: `args.slice(matchedWords)`). The
    // sibling shell + bg index files used skip=1 which silently ate the first
    // positional — fixed in this PR alongside the new sibling.
    const flags = parseFlags(args, {
      "--interval": Number,
      "--timeout":  Number,
      "--help":     Boolean, "-h": "--help",
    }, 0);

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

    await cmdWait(name, {
      intervalSec: flags["--interval"],
      timeoutSec:  flags["--timeout"],
    });

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // WaitTimeoutError → exit code 1 (timeout); other Errors → exit code 2 (args/runtime).
    // The plugin contract is { ok, error }; the CLI host maps ok=false to a
    // non-zero exit. We don't have a way to differentiate 1 vs 2 from here
    // (handler can only signal ok/!ok), so the cleanest discriminator is to
    // include the error class name in the message: `timeout: ...` for timeouts,
    // anything else for arg/usage errors. The shell pattern (grep / case) can
    // act on the message; ergonomic exit codes are a v2 concern once the CLI
    // host gains a richer return contract (#1311 tracker if/when filed).
    return { ok: false, error: msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
