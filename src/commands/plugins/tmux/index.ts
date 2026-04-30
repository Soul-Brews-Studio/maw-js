import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdTmuxPeek, cmdTmuxLs, cmdTmuxSend, cmdTmuxSplit, cmdTmuxKill, cmdTmuxLayout, cmdTmuxAttach } from "./impl";

export const command = {
  name: "tmux",
  description: "tmux control verbs — peek.",
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
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "send") {
      const flags = parseFlags(args, {
        "--literal": Boolean,
        "--allow-destructive": Boolean,
        "--force": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux send <target> <command> [--literal] [--allow-destructive] [--force]");
        console.log("  target:  pane id (%N), session:w.p, team-agent, fleet stem, or session name");
        console.log("  --literal:           don't append Enter (raw keystrokes)");
        console.log("  --allow-destructive: bypass deny-list (rm/sudo/redirect/...)");
        console.log("  --force:             bypass refusal-to-inject-into-claude-pane");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      const command = flags._.slice(1).join(" ");
      if (!target || !command) {
        console.log("usage: maw tmux send <target> <command> [--literal] [--allow-destructive] [--force]");
        return { ok: false, error: "target and command required", output: logs.join("\n") };
      }
      await cmdTmuxSend(target, command, {
        literal: !!flags["--literal"],
        allowDestructive: !!flags["--allow-destructive"],
        force: !!flags["--force"],
      });
    } else if (sub === "ls" || sub === "list") {
      const flags = parseFlags(args, {
        "--all": Boolean,
        "-a": "--all",
        "--json": Boolean,
        "--compact": Boolean,
        "--verbose": Boolean,
        "-v": "--verbose",
        "--roster": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux ls [--all|-a] [--compact] [-v|--verbose] [--roster] [--json]");
        console.log("  default:    panes in current session only");
        console.log("  --all:      panes across every session");
        console.log("  --compact:  one line per session (default for `maw ls`)");
        console.log("  -v:         full per-pane detail (overrides --compact)");
        console.log("  --roster:   include sleeping oracles from ghq");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      await cmdTmuxLs({
        all: !!flags["--all"],
        json: !!flags["--json"],
        compact: !!flags["--compact"],
        verbose: !!flags["--verbose"],
        roster: !!flags["--roster"],
      });
    } else if (sub === "peek") {
      const flags = parseFlags(args, {
        "--lines": Number,
        "--history": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        console.log("  target: pane id (%N), session:w.p, team-agent name, or session name");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      const lines = (flags["--lines"] as number | undefined) ?? 30;
      const history = !!flags["--history"];
      await cmdTmuxPeek(target, { lines, history });
    } else if (sub === "split") {
      const flags = parseFlags(args, {
        "--vertical": Boolean, "-v": "--vertical",
        "--horizontal": Boolean, "-h": "--horizontal",
        "--pct": Number,
        "--cmd": String,
        "--help": Boolean,
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux split <target> [-v|--vertical] [--pct N] [--cmd '<cmd>']");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux split <target> [-v] [--pct N] [--cmd '<cmd>']");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await cmdTmuxSplit(target, {
        vertical: !!flags["--vertical"],
        pct: flags["--pct"] as number | undefined,
        cmd: flags["--cmd"] as string | undefined,
      });
    } else if (sub === "kill") {
      const flags = parseFlags(args, {
        "--force": Boolean,
        "--session": Boolean, "-s": "--session",
        "--help": Boolean, "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux kill <target> [--force] [--session|-s]");
        console.log("  default: kill the pane. --session/-s: kill the whole session.");
        console.log("  refuses fleet/view sessions unless --force.");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux kill <target> [--force] [--session]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await cmdTmuxKill(target, {
        force: !!flags["--force"],
        session: !!flags["--session"],
      });
    } else if (sub === "layout") {
      const flags = parseFlags(args, { "--help": Boolean, "-h": "--help" }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux layout <target> <preset>");
        console.log("  presets: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      const preset = flags._[1];
      if (!target || !preset) {
        console.log("usage: maw tmux layout <target> <preset>");
        return { ok: false, error: "target and preset required", output: logs.join("\n") };
      }
      await cmdTmuxLayout(target, preset);
    } else if (sub === "attach") {
      const flags = parseFlags(args, {
        "--print": Boolean,
        "--help": Boolean, "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux attach <target> [--print]");
        console.log("  default: exec `tmux attach` (or `switch-client` inside $TMUX) when on a TTY.");
        console.log("  --print: print the tmux command instead of exec'ing (auto-on without a TTY).");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux attach <target> [--print]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      cmdTmuxAttach(target, { print: !!flags["--print"] });
    } else if (!sub || sub === "--help" || sub === "-h") {
      console.log("usage: maw tmux <ls|peek|send|split|kill|layout|attach> [args]");
      console.log("  ls [--all]              list panes with fleet + team annotations");
      console.log("  peek <target>           read content of a tmux pane");
      console.log("  send <target> <cmd>     send keys to a pane (with safety gates)");
      console.log("  split <target>          split a pane (--vertical, --pct, --cmd)");
      console.log("  kill <target>           kill a pane or --session (fleet-safe)");
      console.log("  layout <target> <preset> apply a tmux layout preset");
      console.log("  attach <target> [--print] attach to a tmux session (--print to skip exec)");
      return { ok: true, output: logs.join("\n") || undefined };
    } else {
      console.log(`unknown tmux subcommand: ${sub}`);
      console.log("usage: maw tmux <ls|peek|send|split|kill|layout|attach>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
