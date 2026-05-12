/**
 * `maw pane` — unified pane control plugin (#1269).
 *
 * Subcommands:
 *   maw pane split [-h|-v] [-p PERCENT] [-t SESSION:WINDOW] [<command>]
 *   maw pane kill <pane-ref> [--force]
 *   maw pane peek <pane-ref> [--lines N] [--history]
 *   maw pane list [SESSION] [--all] [--json] [--compact] [-v|--verbose]
 *
 * Pane-ref forms (canonical maw resolver — same as `maw tmux peek`):
 *   - %N                  → tmux pane id
 *   - session:window.pane → fully-qualified path
 *   - team-agent name     → looked up via ~/.claude/teams/* /config.json
 *   - bare session name   → pane 0 of that session
 *
 * This plugin is a THIN FACADE — every verb delegates to existing helpers
 * in `tmux/impl.ts`. We never re-implement pane-ref resolution, pct
 * validation, fleet-safety gating, or buffer capture.
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdPaneSplit } from "./split";
import { cmdPaneKill } from "./kill";
import { cmdPanePeek } from "./peek";
import { cmdPaneList } from "./list";

export const command = {
  name: "pane",
  description: "Unified pane control — split, kill, peek, list (#1269).",
};

function printUsage(): void {
  console.log("usage: maw pane <split|kill|peek|list> [args]");
  console.log("  split [-h|-v] [-p PCT] [-t SESSION:WINDOW] [<command>]");
  console.log("  kill <pane-ref> [--force]");
  console.log("  peek <pane-ref> [--lines N] [--history]");
  console.log("  list [SESSION] [--all] [--json] [-v|--verbose]");
  console.log("");
  console.log("pane-ref: %N | session:w.p | team-agent name | session name");
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
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "--help" || sub === "-h") {
      printUsage();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (sub === "split") {
      // Per #1269: -h is horizontal (side-by-side), -v is vertical (stacked).
      // -p is percentage, -t is target session:window. Positional remainder
      // is the command to run in the new pane.
      const flags = parseFlags(args, {
        "--horizontal": Boolean, "-h": "--horizontal",
        "--vertical":   Boolean, "-v": "--vertical",
        "--pct":        Number,  "-p": "--pct",
        "--target":     String,  "-t": "--target",
        "--help":       Boolean,
      }, 1);

      if (flags["--help"]) {
        console.log("usage: maw pane split [-h|-v] [-p PCT] [-t SESSION:WINDOW] [<command>]");
        console.log("  -h, --horizontal   side-by-side split (default)");
        console.log("  -v, --vertical     stacked top/bottom split");
        console.log("  -p, --pct N        new-pane size percent (1-99, default 50)");
        console.log("  -t, --target REF   pane/window to split (default: $TMUX_PANE)");
        console.log("");
        console.log("examples:");
        console.log("  maw pane split -h -p 30 \"tail -f log.txt\"");
        console.log("  maw pane split -v -t mawjs-view \"bash -c 'CMD; read -n1'\"");
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const command = (flags._ as string[]).join(" ");
      await cmdPaneSplit(command, {
        horizontal: !!flags["--horizontal"],
        vertical:   !!flags["--vertical"],
        pct:        flags["--pct"] as number | undefined,
        target:     flags["--target"] as string | undefined,
      });

    } else if (sub === "kill") {
      const flags = parseFlags(args, {
        "--force": Boolean,
        "--help":  Boolean, "-h": "--help",
      }, 1);

      if (flags["--help"]) {
        console.log("usage: maw pane kill <pane-ref> [--force]");
        console.log("  --force   bypass fleet/view session refusal");
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const ref = (flags._ as string[])[0];
      if (!ref) {
        console.log("usage: maw pane kill <pane-ref> [--force]");
        return { ok: false, error: "pane-ref required", output: logs.join("\n") };
      }
      await cmdPaneKill(ref, { force: !!flags["--force"] });

    } else if (sub === "peek") {
      const flags = parseFlags(args, {
        "--lines":   Number,
        "--history": Boolean,
        "--help":    Boolean, "-h": "--help",
      }, 1);

      if (flags["--help"]) {
        console.log("usage: maw pane peek <pane-ref> [--lines N] [--history]");
        console.log("  --lines N    lines from bottom (default 30)");
        console.log("  --history    full scrollback (overrides --lines)");
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const ref = (flags._ as string[])[0];
      if (!ref) {
        console.log("usage: maw pane peek <pane-ref> [--lines N] [--history]");
        return { ok: false, error: "pane-ref required", output: logs.join("\n") };
      }
      await cmdPanePeek(ref, {
        lines: flags["--lines"] as number | undefined,
        history: !!flags["--history"],
      });

    } else if (sub === "list" || sub === "ls") {
      const flags = parseFlags(args, {
        "--all":     Boolean, "-a": "--all",
        "--json":    Boolean,
        "--compact": Boolean,
        "--verbose": Boolean, "-v": "--verbose",
        "--help":    Boolean, "-h": "--help",
      }, 1);

      if (flags["--help"]) {
        console.log("usage: maw pane list [SESSION] [--all] [--json] [-v|--verbose]");
        console.log("  SESSION       filter to one session (positional)");
        console.log("  --all, -a     all sessions (default: current $TMUX session)");
        console.log("  --json        JSON output");
        console.log("  -v, --verbose full per-pane detail");
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const session = (flags._ as string[])[0];
      await cmdPaneList({
        session: session || undefined,
        all: !!flags["--all"],
        json: !!flags["--json"],
        compact: !!flags["--compact"],
        verbose: !!flags["--verbose"],
      });

    } else {
      console.log(`unknown pane subcommand: ${sub}`);
      printUsage();
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
